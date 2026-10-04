import express from 'express';
import cors from "cors";
import axios from 'axios';
import yts from 'yt-search';
import Form_Data from 'form-data';
import youtubeDl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ dest: os.tmpdir() });
const cache_path = path.join(process.cwd(), 'cache.json');

let cache = { expires: 0, movies: new Map() };
let tg_client = null;

class Helper {
    load_cache() {
        if (fs.existsSync(cache_path)) {
            try {
                const raw = fs.readFileSync(cache_path, 'utf8');
                const data = JSON.parse(raw);
                if (data && data.expires > Date.now()) cache = { expires: data.expires, movies: new Map(Object.entries(data.movies || {})) };
            } catch (err) {
                console.error("Failed to read cache file:", err.message);
            }
        }
    }
    save_cache() {
        const serialized = { expires: cache.expires, movies: Object.fromEntries(cache.movies) };
        fs.writeFileSync(cache_path, JSON.stringify(serialized, null, 2));
    }
    advanced_search(query = '', items = []) {
        if (!query || !items || !items.length) return [];
        const normalize = (str) => str.toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();
        const cleanQuery = normalize(query);
        if (!cleanQuery) return [];
        const queryTokens = cleanQuery.split(/\s+/).filter(Boolean);
        const levenshtein = (a, b) => {
            if (a === b) return 0;
            if (!a.length) return b.length;
            if (!b.length) return a.length;
            const row = Array.from({ length: a.length + 1 }, (_, i) => i);
            for (let i = 1; i <= b.length; i++) {
                let prev = i;
                for (let j = 1; j <= a.length; j++) {
                    const val = (b[i - 1] === a[j - 1]) ? row[j - 1] : Math.min(row[j - 1], row[j], prev) + 1;
                    row[j - 1] = prev;
                    prev = val;
                }
                row[a.length] = prev;
            }
            return row[a.length];
        };
        const getSimilarity = (s1, s2) => {
            const maxLen = Math.max(s1.length, s2.length);
            if (maxLen === 0) return 1.0;
            return 1 - (levenshtein(s1, s2) / maxLen);
        };
        const scored = items.map(item => {
            const cleanItem = normalize(item);
            if (!cleanItem) return { item, score: 0 };
            if (cleanItem === cleanQuery) return { item, score: 100 };
            if (cleanItem.startsWith(cleanQuery)) return { item, score: 90 };
            if (cleanItem.includes(cleanQuery)) return { item, score: 80 };
            const itemTokens = cleanItem.split(/\s+/).filter(Boolean);
            let totalTokenScore = 0;
            let matchedCount = 0;
            for (const qToken of queryTokens) {
                let bestTokenSim = 0;
                for (const iToken of itemTokens) {
                    if (iToken === qToken) {
                        bestTokenSim = 1.0;
                        break;
                    }
                    if (iToken.startsWith(qToken) || qToken.startsWith(iToken)) {
                        bestTokenSim = Math.max(bestTokenSim, 0.85);
                    } else if (iToken.includes(qToken) || qToken.includes(iToken)) {
                        bestTokenSim = Math.max(bestTokenSim, 0.7);
                    } else if (qToken.length >= 3 && iToken.length >= 3) {
                        const sim = getSimilarity(qToken, iToken);
                        if (sim >= 0.6) {
                            bestTokenSim = Math.max(bestTokenSim, sim * 0.8);
                        }
                    }
                }
                if (bestTokenSim > 0.3) {
                    matchedCount++;
                    totalTokenScore += bestTokenSim;
                }
            }
            const queryCoverage = totalTokenScore / queryTokens.length;
            const overallSim = getSimilarity(cleanQuery, cleanItem);
            let score = (queryCoverage * 60) + (overallSim * 25);
            if (matchedCount === queryTokens.length) score += 15;
            return { item, score };
        });

        return scored
            .filter(entry => entry.score >= 25)
            .sort((a, b) => b.score - a.score)
            .map(entry => entry.item);
    }
}
const { load_cache, save_cache, advanced_search } = new Helper();


load_cache();

app.get('/api', (req, res) => res.json({ message: "API is up and running!" }));

app.get('/api/search/:type', async (req, res) => {
    const { type } = req.params;
    const { query } = req.query;
    const data = { mode: 'search', type, query, results: [], length: 0 };
    try {
        if (!query) throw new Error('Query parameter is required');
        if (type === 'music') {
            const response = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
            if (!response.data) throw new Error('No music found');
            const list = response.data.data.map(itm => ({ id: itm.id, title: itm.title, preview: itm.preview, thumbnail: itm.album.cover, artist: itm.artist.name, album: itm.album.title }));
            data.results = list;
            data.length = list.length;
        } else if (type === 'yt') {
            const search = await yts(query);
            if (!search || !search.videos.length) throw new Error('No media found!');
            const list = search.videos.map(itm => ({ id: itm.videoId, title: itm.title, author: itm.author.name, url: itm.url, thumbnail: itm.thumbnail, description: itm.description }));
            data.results = list;
            data.length = list.length;
        } else if (type === 'movie') {
            const response = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: process.env.TMDB_API_KEY, query } });
            if (!response.data) throw new Error('No movies found');
            const list = response.data.results.map(movie => ({ id: movie.id, title: movie.title, overview: movie.overview, release_date: movie.release_date, rating: movie.vote_average, poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null }));
            data.results = list;
            data.length = list.length;
        } else throw new Error(`Invalid type parameter`);
        res.json({ ...data });
    } catch (error) {
        console.error(error.message);
        res.status(400).json({ error: error.message || 'Internal Server Error' });
    }
});

app.get('/api/download/:type', async (req, res) => {
    const { type } = req.params;
    const { query, media = 'video' } = req.query;
    const data = { mode: 'download', type, query, media, title: '', thumbnail: '', mimetype: '', size: 0, url: '', expires: Date.now() };
    let temp = '', file_name = '';

    try {
        if (!query) throw new Error('Query parameter is required');
        if (type === 'yt') {
            let url = query;
            if (!/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/|playlist\?list=)?)([a-zA-Z0-9_-]{11})/i.test(query)) {
                const response = await yts(query).then(r => r);
                if (!response || !response.videos.length) throw new Error('No media found!');
                const video = response.videos[0];
                url = video.url;
                data.title = video.title;
                data.thumbnail = video.thumbnail;
            }
            const output_base = path.join(os.tmpdir(), `${Date.now()}_download`);
            await youtubeDl.exec(url, {
                output: `${output_base}.%(ext)s`,
                format: media === 'audio' ? 'bestaudio/best' : 'bestvideo*+bestaudio/best',
                cookies: path.join(process.cwd(), 'cookies.txt'),
                jsRuntimes: 'node',
                ...(media === 'audio' ? { extractAudio: true, audioFormat: 'mp3' } : { mergeOutputFormat: 'mp4' }),
            });
            const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(output_base)));
            if (!files.length) throw new Error('Downloaded file not found');
            temp = path.join(os.tmpdir(), files[0]);
            file_name = path.basename(temp);
            data.mimetype = media === 'audio' ? 'audio/mpeg' : 'video/mp4';
        } else if (type === 'movie') {
            if (!process.env.TG_API_ID || !process.env.TG_API_HASH || !process.env.TG_SESSION || !process.env.TG_CHANNEL_ID) throw new Error("Required Telegram environment variables are missing.");
            load_cache();
            const channel = process.env.TG_CHANNEL_ID.trim();
            if (!tg_client) tg_client = new TelegramClient(new StringSession(process.env.TG_SESSION), Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 5 });
            try {
                await tg_client.connect();
                if (!await tg_client.checkAuthorization()) throw new Error("Invalid or expired TG_SESSION.");
                if (!cache.movies.size || Date.now() >= cache.expires) {
                    cache.movies.clear();
                    for await (const msg of tg_client.iterMessages(channel, { limit: 1000 })) {
                        if (!msg.media) continue;
                        let name = '';
                        if (msg.media.document) {
                            const attributes = msg.media.document.attributes || [];
                            const attr = attributes.find(a => a.fileName);
                            if (attr) name = attr.fileName;
                        }
                        if (!name) continue;
                        if (!['.mkv', '.mp4', '.avi', '.mov'].some(ext => name.toLowerCase().endsWith(ext))) continue;
                        let title = name
                            .replace(/\[[^\]]*\]/g, '')
                            .replace(/\((?![0-9]{4}\)[^)]*$).*?\)/g, '')
                            .replace(/@\w+|https?:\/\/\S+/gi, '')
                            .replace(/\b(WEB[- ]?DL|WEBRip|WEB[- ]?HD|BluRay|BRRip|BDRip|HDRip|DVDRip|HDTV|CAM|TS|TC|PreDvD|Dual[- ]Audio|ORG|ESubs|3D|6CH|2\.0|5\.1|7\.1|480p|576p|720p|1080p|2160p|4k|8k|x264|x265|h264|h265|HEVC|10bit|AAC2?|AC3|DTS|Pahe(?:\.in3?)?|YTS|RARBG|PSA|EVO|EMTV|asaomatv|fzmovies(?:\.net)?|VegaMovies|NetNaija(?:\.com)?|PSADOCX)\b/gi, '')
                            .replace(/\b\d+(?:\.\d+)?(?:MB|GB)\b/gi, '')
                            .replace(/[._-]+/g, ' ')
                            .replace(/\b(mkv|mp4|avi|mov)\b/gi, '')
                            .replace(/\s+/g, ' ')
                            .trim();
                        if (!title) continue;
                        const key = title.toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();
                        cache.movies.set(key, { title, messageId: msg.id, filename: name });
                    }
                    cache.expires = Date.now() + (1000 * 60 * 60 * 3);
                    save_cache();
                }
                const match = advanced_search(query, Array.from(cache.movies.keys()))[0];
                if (!match) throw new Error(`${query} not found in database. Try spelling it a different way or request an admin to add the movie to the database.`);
                const { title, messageId, filename } = cache.movies.get(match);
                const msg = (await tg_client.getMessages(channel, { ids: messageId }))[0];
                if (!msg || !msg.media) throw new Error('Failed to retrieve the media from Telegram.');
                temp = path.join(os.tmpdir(), `${Date.now()}_${filename}`);
                await tg_client.downloadMedia(msg, { outputFile: temp });
                file_name = filename;
                data.title = title;
                const ext = path.extname(filename).slice(1).toLowerCase();
                data.mimetype = ext === 'mkv' ? 'video/x-matroska' : ext === 'avi' ? 'video/x-msvideo' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
                data.title = title;
            } finally {
                await tg_client.disconnect();
            }
        } else throw new Error('Unsupported download type');
        if (!temp || !fs.existsSync(temp)) throw new Error('Failed to prepare media file');
        const stats = fs.statSync(temp);
        data.size = stats.size;
        const formData = new Form_Data();
        formData.append("reqtype", "fileupload");
        formData.append("time", "24h");
        formData.append("fileToUpload", fs.createReadStream(temp), { filename: file_name, contentType: data.mimetype });
        const response = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", formData, { headers: formData.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
        data.url = response.data.trim();
        data.expires = Date.now() + (1000 * 60 * 60 * 24);
        res.json({ ...data });
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: error.message || 'Internal Server Error' });
    } finally {
        if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    }
});

app.post('/api/upload/:type', upload.single('image'), async (req, res) => {
    const { type } = req.params;
    const file = req.file;
    const data = { mode: 'upload', mimetype: '', url: '', size: 0, expires: Infinity };
    try {
        if (!file) throw new Error('No image file uploaded');
        const stats = fs.statSync(file.path);
        data.size = stats.size;
        const formData = new Form_Data();
        if (type === 'image') {
            if (!process.env.IMGBB_API_KEY) throw new Error('Required environment variable is missing.');
            const base64 = fs.readFileSync(file.path, { encoding: 'base64' });
            const params = new URLSearchParams();
            params.append('image', base64);
            const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, params);
            const img = response.data.data;
            data.mimetype = img.image.mime;
            data.url = img.display_url;
        } else if (type === 'file') {
            formData.append("reqtype", "fileupload");
            formData.append("time", "24h");
            formData.append("fileToUpload", fs.createReadStream(file.path));
            const response = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", formData, { headers: formData.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
            data.url = response.data.trim();
            data.expires = Date.now() + (1000 * 60 * 60 * 24);
        }
        res.json({ ...data });
    } catch (error) {
        console.error(error.message);
        res.status(400).json({ error: error.message || 'Internal Server Error' });
    } finally {
        if (fs.existsSync(file?.path)) fs.unlinkSync(file?.path);
    }
});

export default app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));