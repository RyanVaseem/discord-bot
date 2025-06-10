import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import pkg from '@apollo/client';
const { ApolloClient, InMemoryCache, gql, HttpLink } = pkg;
import fetch from 'node-fetch';
import axios from 'axios';
import mongoose from 'mongoose';
import cron from 'node-cron';
import dotenv from 'dotenv';

import express from 'express';

// Setup a web server for Replit uptime
const app = express();
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(3000, () => console.log('Uptime server running on port 3000'));


dotenv.config();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ]
});

const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI);
const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => console.log('Connected to MongoDB'));

const subscriptionSchema = new mongoose.Schema({
    userId: String,
    animeSubscriptions: [
        {
            name: String,
            currentEpisode: Number,
            newEpisode: Number
        }
    ],
    mangaSubscriptions: [
        {
            name: String,
            currentChapter: Number,
            newChapter: Number
        }
    ],
    guildId: String, 
    notificationChannelId: String,
    commandChannelId: String    
});
const Subscription = mongoose.model('Subscription', subscriptionSchema);

const TOKEN = process.env.TOKEN;
const ANILIST_API = 'https://graphql.anilist.co';

const apolloClient = new ApolloClient({
    link: new HttpLink({ uri: ANILIST_API, fetch }),
    cache: new InMemoryCache(),
});

async function getAnimeInfo(animeName) {
    const query = gql`
        query ($search: String) {
            Media(search: $search, type: ANIME) {
                title {
                    romaji
                    english
                }
                episodes
                siteUrl
                nextAiringEpisode {
                    episode
                }
            }
        }
    `;
    try {
        const { data } = await apolloClient.query({ query, variables: { search: animeName } });
        const anime = data.Media;
        if (!anime) return null;
        const nextEp = anime.nextAiringEpisode?.episode;
        const latestEp = nextEp ? nextEp - 1 : anime.episodes;
        return {
            animeTitle: anime.title.english || anime.title.romaji,
            latestEpisode: latestEp || 0,
            episodeUrl: anime.siteUrl
        };
    } catch (err) {
        if (err?.networkError?.statusCode === 429) {
            console.warn(`[RETRY] Hit 429 for ${animeName}, retrying in 2s...`);
            await new Promise(res => setTimeout(res, 2000)); // Wait 2s
            return await getAnimeInfo(animeName); // Retry once
        }
        console.error("Anime fetch error:", err);
        return null;
    }
}
import cheerio from 'cheerio';

async function fetchAnimeKaiLink(animeTitle, episodeNumber) {
    try {
        const searchUrl = `https://animekai.to/search?keyword=${encodeURIComponent(animeTitle)}`;
        const { data } = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const $ = cheerio.load(data);

        const result = $('.film_list-wrap .flw-item a').first().attr('href');
        if (!result) return null;

        const match = result.match(/\/watch\/([^\/?#]+)/); // extract slug-id
        const slugId = match ? match[1] : null;
        if (!slugId) return null;

        return `https://animekai.to/watch/${slugId}#ep=${episodeNumber}`;
    } catch (err) {
        console.error(`[AnimeKai] Error for "${animeTitle}":`, err.message);
        return null;
    }
}


async function fetchHiAnimeLink(animeTitle, episodeNumber) {
    try {
        const searchUrl = `https://hianime.to/search?keyword=${encodeURIComponent(animeTitle)}`;
        const { data: searchData } = await axios.get(searchUrl);
        const $ = cheerio.load(searchData);

        const animeSlug = $('.flw-item a').first().attr('href');  // e.g., /watch/one-piece-100
        if (!animeSlug) return null;

        const animePageUrl = `https://hianime.to${animeSlug}`;
        const { data: animePage } = await axios.get(animePageUrl);
        const $$ = cheerio.load(animePage);

        const epLink = $$(`a.ep-item[data-number="${episodeNumber}"]`).attr('href');
        if (!epLink) return null;

        return `https://hianime.to${epLink}`;
    } catch (err) {
        console.error(`[HiAnime] Error for "${animeTitle}":`, err.message);
        return null;
    }
}


function slugify(title) {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '');
}

function buildStaticStreamingLinks(animeTitle, episodeNumber) {
    const slug = slugify(animeTitle);

    return {
        HiAnime: `https://hianime.to/watch/${slug}-episode-${episodeNumber}`,
        ZoroTV: `https://zorotv.com.lv/watch/${slug}-episode-${episodeNumber}`,
        GogoAnime: `https://gogoanime.by/${slug}-episode-${episodeNumber}`
    };
}
async function getAllStreamingLinks(animeTitle, episodeNumber) {
    const staticLinks = buildStaticStreamingLinks(animeTitle, episodeNumber);
    const animeKaiLink = await fetchAnimeKaiLink(animeTitle, episodeNumber);

    const allLinks = {
        ...staticLinks,
        AnimeKai: animeKaiLink || 'Not found'
    };

    return allLinks;
}

import axios from 'axios';
import cheerio from 'cheerio';

async function getMangaInfo(mangaName) {
    try {
        // 1. Search for the manga on TCB
        const searchUrl = `https://www.tcbscans.org/?s=${encodeURIComponent(mangaName)}`;
        const searchRes = await axios.get(searchUrl);
        const $search = cheerio.load(searchRes.data);

        const mangaLink = $search('h3.post-title a').first().attr('href');
        if (!mangaLink) {
            console.warn(`[TCB] No search result found for: ${mangaName}`);
            return null;
        }

        // 2. Visit the manga page and extract latest chapter
        const pageRes = await axios.get(mangaLink);
        const $page = cheerio.load(pageRes.data);

        const title = $page('h1.entry-title').text().trim() || mangaName;

        const latestChapterAnchor = $page('ul.main li a').first();
        const latestChapterUrl = latestChapterAnchor.attr('href');
        const chapterText = latestChapterAnchor.text().trim();
        const chapterNum = parseFloat(chapterText.replace(/[^0-9.]/g, ''));

        if (!latestChapterUrl || isNaN(chapterNum)) {
            console.warn(`[TCB] Failed to extract latest chapter for ${mangaName}`);
            return null;
        }

        return {
            mangaTitle: title,
            latestChapter: chapterNum,
            latestChapterUrl: latestChapterUrl
        };

    } catch (err) {
        console.error(`[TCB] Error while scraping ${mangaName}:`, err.message);
        return null;
    }
}




async function notifySubscribers(type, title, url, userIds) {
    for (const userId of userIds) {
        const subscription = await Subscription.findOne({ userId });
        if (!subscription) continue;

        // ✅ fallback to commandChannel if notificationChannel is not set
        const channelId = subscription.notificationChannelId || subscription.commandChannelId;
        if (!channelId) {
            console.log(`[SKIP] No valid channel ID for user ${userId}`);
            continue;
        }
        try {
            const channel = await client.channels.fetch(channelId);
            const mention = `<@${userId}>`;
            const msg = `${mention}, new ${type} update for **${title}**!\n${url}`;
            await channel.send(msg);
        } catch (e) {
            console.error(`Failed to notify ${userId}`, e);
        }
    }
}


cron.schedule('* * * * *', async () => {
    console.log('[CRON] Checking for updates...');

    const subscriptions = await Subscription.find({});
    const animeMap = new Map(); // title -> array of { userId, anime, sub, channelId }
    const mangaMap = new Map();

    // Group all subscriptions by anime and manga title (case-insensitive)
    for (const sub of subscriptions) {
        for (const anime of sub.animeSubscriptions) {
            const key = anime.name.toLowerCase();
            if (!animeMap.has(key)) animeMap.set(key, []);
            animeMap.get(key).push({
                userId: sub.userId,
                anime,
                sub,
                channelId: sub.notificationChannelId || sub.commandChannelId
            });
        }
        for (const manga of sub.mangaSubscriptions) {
            const key = manga.name.toLowerCase();
            if (!mangaMap.has(key)) mangaMap.set(key, []);
            mangaMap.get(key).push({
                userId: sub.userId,
                manga,
                sub,
                channelId: sub.notificationChannelId || sub.commandChannelId
            });
        }
    }

    // === Anime Check ===
    for (const [animeTitle, entries] of animeMap.entries()) {
        await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 500));
        const info = await getAnimeInfo(animeTitle);
        if (!info) {
            console.log(`[SKIP] No info for anime: ${animeTitle}`);
            continue;
        }

        for (const { userId, anime, sub, channelId } of entries) {
            console.log(`[CHECK] Anime: ${anime.name} — Current: ${anime.currentEpisode}, Latest: ${info.latestEpisode}`);
            anime.newEpisode = info.latestEpisode;
            if ((anime.currentEpisode || 0) < info.latestEpisode) {
                console.log(`[NOTIFY] New episode for ${anime.name} → notifying ${userId}`);
                const links = await getAllStreamingLinks(info.animeTitle, info.latestEpisode);
                const linksText = Object.entries(links)
                    .map(([name, url]) => `• **${name}**: ${url}`)
                    .join('\n');
                    const msg = `${mention}, new anime update for **${info.animeTitle}**!\n${linkMsg}`;
                    await channel.send(msg);

                if (channelId) {
                    const mention = `<@${userId}>`;
                    const msg = `${mention}, new anime update for **${info.animeTitle}**!\n${linksText}`;
                    try {
                        const channel = await client.channels.fetch(channelId);
                        await channel.send(msg);
                    } catch (err) {
                        console.error(`[ERROR] Failed to notify ${userId} in ${channelId}`, err);
                    }
                }
                anime.currentEpisode = info.latestEpisode;
                await sub.save();
            }
        }
    }

    // === Manga Check ===
    for (const [mangaTitle, entries] of mangaMap.entries()) {
        await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 300));
        const info = await getMangaInfo(mangaTitle);
        if (!info) {
            console.log(`[SKIP] No info for manga: ${mangaTitle}`);
            continue;
        }

        for (const { userId, manga, sub, channelId } of entries) {
            console.log(`[CHECK] Manga: ${manga.name} — Current: ${manga.currentChapter}, Latest: ${info.latestChapter}`);
            manga.newChapter = info.latestChapter;
            if ((manga.currentChapter || 0) < info.latestChapter) {
                console.log(`[NOTIFY] New chapter for ${manga.name} → notifying ${userId}`);
                if (channelId) {
                    const mention = `<@${userId}>`;
                    const msg = `${mention}, new manga update for **${info.mangaTitle}**!\n${info.latestChapterUrl}`;
                    try {
                        const channel = await client.channels.fetch(channelId);
                        await channel.send(msg);
                    } catch (err) {
                        console.error(`[ERROR] Failed to notify ${userId} in ${channelId}`, err);
                    }
                }
                manga.currentChapter = info.latestChapter;
                await sub.save();
            }
        }
    }
});



function shouldSkipCommand(subscription, message) {
    if (!subscription?.notificationChannelId) return false;

    return message.channel.id !== subscription.notificationChannelId;
}
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const mentionPattern = new RegExp(`^<@!?${client.user.id}>`);
    if (!mentionPattern.test(message.content)) return;


    console.log(`[RAW] Message Content: "${message.content}"`);

    const args = message.content.replace(mentionPattern, '').trim().split(/ +/);
    const command = args.shift()?.toLowerCase();

    console.log(`[COMMAND] Parsed: "${command}" | Args: ${args.join(' ')}`);

    const validCommands = [
        'help', 'h',
        'notify_anime',
        'notify_manga',
        'delete_anime',        
        'delete_manga',          
        'my_subscriptions',
        'get_anime',
        'get_manga',
        'setchannel',
        'setnotificationchannel'
    ];



    const userId = message.author.id;
    const guildId = message.guild?.id;
    let subscription = await Subscription.findOne({ userId, guildId });
    if (!subscription) {
        // Try to inherit settings from another user in the same guild
        const existingGuildSub = await Subscription.findOne({ guildId });

        subscription = new Subscription({
            userId,
            guildId,
            animeSubscriptions: [],
            mangaSubscriptions: [],
            notificationChannelId: existingGuildSub?.notificationChannelId || null,
            commandChannelId: existingGuildSub?.commandChannelId || null
        });
        await subscription.save(); 

    }
    if (subscription.commandChannelId && message.channel.id !== subscription.commandChannelId) {
        console.log(`[BLOCKED] Command from wrong channel. Expected: ${subscription.commandChannelId}, got: ${message.channel.id}`);
        return;
    }
    if (!command) {
        return message.channel.send("Hi! Type \`@BotName help\` to use the bot");
    }
    if (!validCommands.includes(command)) {
        return message.channel.send(`Unknown command: \`${command}\`\nTry \`@BotName help\` to see what I can do.`);
    }
    if (command === 'h' || command === 'help') {
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Anime/Manga Bot Commands')
            .setDescription('Here are the available commands you can use:')
            .addFields(
                {
                    name: '**notify_anime <name>**',
                    value: 'Subscribe to an anime. You will be notified when a new episode is released.',
                    inline: false
                },
                {
                    name: '**notify_manga <name>**',
                    value: 'Subscribe to a manga. You will be notified when a new chapter is released.',
                    inline: false
                },
                {
                    name: '**delete_anime <name>**',
                    value: 'Unsubscribe from an anime so you no longer get episode notifications.',
                    inline: false
                },
                {
                    name: '**delete_manga <name>**',
                    value: 'Unsubscribe from a manga so you no longer get chapter notifications.',
                    inline: false
                },
                {
                    name: '**my_subscriptions**',
                    value: 'Shows the anime and manga you’re subscribed to.',
                    inline: false
                },
                {
                    name: '**get_anime <name>**',
                    value: 'Fetches information about a specific anime.',
                    inline: false
                },
                {
                    name: '**get_manga <name>**',
                    value: 'Fetches information about a specific manga.',
                    inline: false
                },
                { 
                    name: '**setchannel <channel name>**', 
                    value: 'Set the only channel allowed to run commands.', 
                    inline: false 
                },
                { 
                    name: '**setnotificationchannel <channel name>**', 
                    value: 'Set the channel where notifications are sent (optional).', 
                    inline: false 
                }
            )
            .setFooter({ text: 'Mention the bot or use @BotName help to see this menu anytime.' });

        return message.channel.send({ embeds: [embed] });
    }



    if (command === 'notify_manga') {
        const mangaName = args.join(' ');
        const info = await getMangaInfo(mangaName);
        if (!info) return message.channel.send("Manga not found.");
        if (!subscription.mangaSubscriptions.some(m => m.name.toLowerCase() === mangaName.toLowerCase())) {
            subscription.mangaSubscriptions.push({
                name: info.mangaTitle,
                currentChapter: info.latestChapter,
                newChapter: info.latestChapter
            });
            await subscription.save();
            return message.channel.send(`Subscribed to ${info.mangaTitle} manga updates.`);
        }
        return message.channel.send(`Already subscribed to ${info.mangaTitle}.`);
    }

    if (command === 'notify_anime') {
        console.log(`[DEBUG] Processing notify_anime`);

        const animeName = args.join(' ');
        console.log(`[DEBUG] Searching anime: ${animeName}`);
        const info = await getAnimeInfo(animeName);
        if (!info) return message.channel.send("Anime not found.");
        if (!subscription.animeSubscriptions.some(a => a.name.toLowerCase() === animeName.toLowerCase())) {
            subscription.animeSubscriptions.push({
                name: info.animeTitle,
                currentEpisode: info.latestEpisode,
                newEpisode: info.latestEpisode
            });
            await subscription.save();
            return message.channel.send(`Subscribed to ${info.animeTitle} anime updates.`);
        }
        return message.channel.send(`Already subscribed to ${info.animeTitle}.`);
    }
    if (command === 'setchannel') {
        const channelName = args.join(' ').toLowerCase();
        const guild = message.guild;

        if (!guild) return message.channel.send("This command must be run in a server.");

        const targetChannel = guild.channels.cache.find(
            ch => ch.name.toLowerCase() === channelName && ch.isTextBased()
        );

        if (!targetChannel) {
            return message.channel.send(`Channel "${channelName}" not found. Be sure to type it exactly (case-insensitive, no #).`);
        }

        const userId = message.author.id;
        let subscription = await Subscription.findOne({ userId, guildId: guild.id });
        if (!subscription) {
            subscription = new Subscription({ userId, guildId: guild.id, animeSubscriptions: [], mangaSubscriptions: [] });
        }

        subscription.commandChannelId = targetChannel.id;

        if (!subscription.notificationChannelId) {
            subscription.notificationChannelId = targetChannel.id;
        }

        await subscription.save();

        return message.channel.send(`Commands will now only be accepted in <#${targetChannel.id}>.`);
    }

    if (command === 'setnotificationchannel') {
        const channelName = args.join(' ').toLowerCase();
        const guild = message.guild;

        if (!guild) return message.channel.send("This command must be run in a server.");

        const targetChannel = guild.channels.cache.find(
            ch => ch.name.toLowerCase() === channelName && ch.isTextBased()
        );

        if (!targetChannel) {
            return message.channel.send(`Channel "${channelName}" not found. Make sure the name is exact.`);
        }

        subscription.notificationChannelId = targetChannel.id;
        await subscription.save();

        return message.channel.send(`Notifications will now be sent to <#${targetChannel.id}>.`);
    }


    if (command === 'my_subscriptions') {
        const animeList = subscription.animeSubscriptions.map(a => a.name).join(', ') || 'None';
        const mangaList = subscription.mangaSubscriptions.map(m => m.name).join(', ') || 'None';
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Your Subscriptions')
            .addFields(
                { name: 'Anime', value: animeList },
                { name: 'Manga', value: mangaList }
            );
        return message.channel.send({ embeds: [embed] });
    }
    if (command === 'delete_anime') {
        const animeName = args.join(' ').toLowerCase();
        const index = subscription.animeSubscriptions.findIndex(a => a.name.toLowerCase() === animeName);
        if (index === -1) return message.channel.send(`You're not subscribed to ${animeName}.`);
        subscription.animeSubscriptions.splice(index, 1);
        await subscription.save();
        return message.channel.send(`Unsubscribed from ${animeName} anime updates.`);
    }

    if (command === 'delete_manga') {
        const mangaName = args.join(' ').toLowerCase();
        const index = subscription.mangaSubscriptions.findIndex(m => m.name.toLowerCase() === mangaName);
        if (index === -1) return message.channel.send(`You're not subscribed to ${mangaName}.`);
        subscription.mangaSubscriptions.splice(index, 1);
        await subscription.save();
        return message.channel.send(`Unsubscribed from ${mangaName} manga updates.`);
    }


    return message.channel.send("Unknown command or missing arguments.");
});

client.once('ready', () => {
    console.log(`Bot is online as ${client.user.tag}`);

    // Define your daily status options
    const dailyStatuses = [
        { name: 'new anime episodes...', type: 3 }, 
        { name: 'manga updates...', type: 1 }        
    ];

    const setDailyStatus = () => {
        const today = new Date().getDate();
        const statusIndex = today % dailyStatuses.length;

        client.user.setPresence({
            activities: [dailyStatuses[statusIndex]],
            status: 'online'
        });

        const label = dailyStatuses[statusIndex].type === 3 ? 'Watching' : 'Streaming';
        console.log(`[STATUS] Set to: ${label} ${dailyStatuses[statusIndex].name}`);
    };

    setDailyStatus();

    setInterval(setDailyStatus, 24 * 60 * 60 * 1000);
});


client.login(TOKEN);