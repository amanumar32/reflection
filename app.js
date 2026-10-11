import express from 'express';
import cors from "cors";
import axios from 'axios';
import yts from 'yt-search';
import youtubeDl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import PQueue from 'p-queue';
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const download_queue = new PQueue({ concurrency: 1 });

const app = express();
app.use(express.json());
app.use(cors());

const upload = multer({ dest: os.tmpdir() });
const cache_path = path.join(process.cwd(), 'cache.json');

let cache = { expires: 0, movies: new Map() };
let tg_client = null;

const s3Client = new S3Client({
    region: "auto",
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

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
    async upload_to_s3(fileBuffer, fileName, contentType) {
        try {
            const command = new PutObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: fileName,
                Body: fileBuffer,
                ContentType: contentType,
            });
            await s3Client.send(command);
            const getCommand = new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: fileName,
            });
            const signedUrl = await getSignedUrl(s3Client, getCommand, { expiresIn: 86400 });
            return signedUrl;
        } catch (error) {
            console.error("Failed to upload to S3 or generate signed URL:", error);
            throw error;
        }
    }
}
const { load_cache, save_cache, advanced_search, upload_to_s3 } = new Helper();


load_cache();

app.get('/api', (req, res) => res.json({ message: "API is up and running!" }));

app.get('/api/search/:type', async (req, res) => {
    const { type } = req.params;
    const { query } = req.query;
    const data = { mode: 'search', type, query, results: [], length: 0 };
    try {
        if (!query) throw new Error('Query parameter is required', { cause: 400 });
        if (type === 'music') {
            const response = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
            if (!response.data) throw new Error('No music found', { cause: 404 });
            const list = response.data.data.map(itm => ({ id: itm.id, title: itm.title, preview: itm.preview, thumbnail: itm.album.cover_big, artist: itm.artist.name, album: itm.album.title }));
            data.results = list;
            data.length = list.length;
        } else if (type === 'yt') {
            const search = await yts(query);
            if (!search || !search.videos.length) throw new Error('No media found!', { cause: 404 });
            const list = search.videos.map(itm => ({ id: itm.videoId, title: itm.title, author: itm.author.name, url: itm.url, thumbnail: itm.thumbnail, description: itm.description }));
            data.results = list;
            data.length = list.length;
        } else if (type === 'movie') {
            const response = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: process.env.TMDB_API_KEY, query } });
            if (!response.data) throw new Error('No movies found', { cause: 404 });
            const list = response.data.results.map(movie => ({ id: movie.id, title: movie.title, overview: movie.overview, release_date: movie.release_date, rating: movie.vote_average, poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null }));
            data.results = list;
            data.length = list.length;
        } else throw new Error('Invalid type parameter', { cause: 400 });
        res.json({ ...data });
    } catch (error) {
        console.error(error);
        res.status(error.cause || 500).json({ error: error.message || 'Internal Server Error' });
    }
});

app.get('/api/download/:type', async (req, res) => {
    const { type } = req.params;
    const { query, media = 'video' } = req.query;
    const data = { mode: 'download', type, query, media, title: '', thumbnail: '', mimetype: '', size: 0, url: '', expires: Date.now() };
    let temp = '', file_name = '';

    try {
        const result = await download_queue.add(async () => {
            if (!query) throw new Error('Query parameter is required', { cause: 400 });
            if (type === 'yt') {
                let url = query;
                if (!/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/|playlist\?list=)?)([a-zA-Z0-9_-]{11})/i.test(query)) {
                    const response = await yts(query).then(r => r);
                    if (!response || !response.videos.length) throw new Error('No media found!', { cause: 404 });
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
                    remoteComponents: 'ejs:github',
                    ...(media === 'audio' ? { extractAudio: true, audioFormat: 'mp3' } : { mergeOutputFormat: 'mp4' }),
                });
                const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(output_base)));
                if (!files.length) throw new Error('Downloaded file not found', { cause: 500 });
                temp = path.join(os.tmpdir(), files[0]);
                file_name = path.basename(temp);
                data.mimetype = media === 'audio' ? 'audio/mpeg' : 'video/mp4';
            } else if (type === 'movie') {
                throw new Error("This endpoint has been deprecated", { cause: 400 });
            } else throw new Error('Unsupported download type', { cause: 400 });

            if (!temp || !fs.existsSync(temp)) throw new Error('Failed to prepare media file', { cause: 500 });
            const stats = fs.statSync(temp);
            data.size = stats.size;
            const fileBuffer = fs.readFileSync(temp);
            const unique = `${Date.now()}_${file_name}`;

            data.url = await upload_to_s3(fileBuffer, unique, data.mimetype);
            data.expires = Date.now() + (1000 * 60 * 60 * 24);
            return data;
        });
        res.json({ ...result });
    } catch (error) {
        console.error(error);
        res.status(error.cause || 500).json({ error: error.message || 'Internal Server Error' });
    } finally {
        if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
    }
});

app.post('/api/upload/:type', upload.single('image'), async (req, res) => {
    const { type } = req.params;
    const file = req.file;
    const data = { mode: 'upload', mimetype: '', url: '', size: 0, expires: Infinity };
    try {
        if (!file) throw new Error('No file uploaded', { cause: 400 });
        const stats = fs.statSync(file.path);
        data.size = stats.size;

        if (type === 'image') {
            if (!process.env.IMGBB_API_KEY) throw new Error('Required environment variable is missing.', { cause: 500 });
            const base64 = fs.readFileSync(file.path, { encoding: 'base64' });
            const params = new URLSearchParams();
            params.append('image', base64);
            const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, params);
            const img = response.data.data;
            data.mimetype = img.image.mime;
            data.url = img.display_url;
        } else if (type === 'file') {
            const fileBuffer = fs.readFileSync(file.path);
            const file_name = `${Date.now()}_${file.originalname || 'upload'}`;
            data.mimetype = file.mimetype || 'application/octet-stream';
            data.url = await upload_to_s3(fileBuffer, file_name, data.mimetype);
            data.expires = Date.now() + (1000 * 60 * 60 * 24);
        }
        res.json({ ...data });
    } catch (error) {
        console.error(error);
        res.status(error.cause || 500).json({ error: error.message || 'Internal Server Error' });
    } finally {
        if (fs.existsSync(file?.path)) fs.unlinkSync(file?.path);
    }
});

export default app;

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));