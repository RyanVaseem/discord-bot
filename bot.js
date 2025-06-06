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
        console.error("Anime fetch error:", err);
        return null;
    }
}

async function getMangaInfo(mangaName) {
    try {
        const searchUrl = `https://api.mangadex.org/manga?title=${encodeURIComponent(mangaName)}`;
        const searchRes = await axios.get(searchUrl);

        const mangaData = searchRes.data.data; // ✅ This was missing
        if (!mangaData || mangaData.length === 0) return null;

        const manga = mangaData.find(m =>
            m.attributes.title.en?.toLowerCase() === mangaName.toLowerCase()
        ) || mangaData[0];

        const mangaId = manga.id;
        const title = manga.attributes.title.en || manga.attributes.title.jp || mangaName;

        const chaptersRes = await axios.get(`https://api.mangadex.org/chapter?manga=${mangaId}&order[chapter]=desc&limit=1`);
        const latest = chaptersRes.data.data[0];
        const latestNum = parseFloat(latest?.attributes.chapter) || 0;
        const latestUrl = `https://mangadex.org/chapter/${latest.id}`;

        return {
            mangaTitle: title,
            latestChapter: latestNum,
            latestChapterUrl: latestUrl
        };
    } catch (err) {
        console.error("Manga fetch error:", err);
        return null;
    }
}


async function notifySubscribers(type, title, url, userIds) {
    for (const userId of userIds) {
        const subscription = await Subscription.findOne({ userId });
        if (!subscription) continue;

        // ✅ fallback to commandChannel if notificationChannel is not set
        const channelId = subscription.notificationChannelId || subscription.commandChannelId;
        if (!channelId) continue;

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
    for (const sub of subscriptions) {
        for (const manga of sub.mangaSubscriptions) {
            const info = await getMangaInfo(manga.name);
            if (!info) continue;

            const { mangaTitle, latestChapter, latestChapterUrl } = info;
            manga.newChapter = latestChapter;

            if ((manga.currentChapter || 0) < latestChapter) {
                await notifySubscribers('manga', mangaTitle, latestChapterUrl, sub);
                manga.currentChapter = latestChapter;
            }
        }

        for (const anime of sub.animeSubscriptions) {
            const info = await getAnimeInfo(anime.name);
            if (!info) continue;

            const { animeTitle, latestEpisode, episodeUrl } = info;
            anime.newEpisode = latestEpisode;

            if ((anime.currentEpisode || 0) < latestEpisode) {
                await notifySubscribers('anime', animeTitle, episodeUrl, sub);
                anime.currentEpisode = latestEpisode;
            }
        }

        await sub.save();
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
        console.log(`[DB] Creating new subscription for ${userId} in guild ${guildId}`);
        subscription = new Subscription({
            userId,
            guildId,
            animeSubscriptions: [],
            mangaSubscriptions: [],
            notificationChannelId: null,
            commandChannelId: null
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
    if (command === 'h' || command === 'help'){
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
                name: 'setchannel <channel name>', 
                value: 'Set the only channel allowed to run commands.', 
                inline: false 
            },
            { 
                name: 'setnotificationchannel <channel name>', 
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

    return message.channel.send("Unknown command or missing arguments.");
});

client.once('ready', () => {
    console.log(`Bot is online as ${client.user.tag}`);

    // Define your daily status options
    const dailyStatuses = [
        { name: 'new anime episodes...', type: 3 },  // Watching
        { name: 'manga updates...', type: 1 }        // Streaming
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