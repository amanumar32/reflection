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
let cache = { expires: Date.now() + (1000 * 60 * 60 * 3), movies: new Map() };
const cache_path = path.join(process.cwd(), 'cache.json');
if (!fs.existsSync(cache_path)) fs.writeFileSync(cache_path, JSON.stringify(cache));

app.get('/api', (req, res) => res.json({ message: "API is up and running!" }));

app.get('/api/search/:type', async (req, res) => {
    const { type } = req.params;
    const { query } = req.query;
    if (!query) throw new Error('Query parameter is required');
    const data = { mode: 'search', type, query, results: [], length: 0 };
    try {
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
    try {
        const { type } = req.params;
        const { query, media = 'video' } = req.query;
        if (!query) throw new Error('Query parameter is required');
        const data = { mode: 'download', type, query, media, title: '', thumbnail: '', mimetype: '', size: 0, url: '', expires: Date.now() };
        let temp = '', file_name = '';
        const additional = { title: '', thumbnail: '' }
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
            const output_base = path.join(os.tmpdir(), `${Date.now()}_${(data.title || query).replace(/[^a-zA-Z0-9]/g, '_')}`);
            const result = await youtubeDl.exec(url, {
                output: `${output_base}.%(ext)s`,
                format: media === 'audio' ? 'bestaudio/best' : 'bestvideo*+bestaudio/best',
                cookies: path.join(process.cwd(), 'cookies.txt'),
                jsRuntimes: 'node',
                ...(media === 'audio' ? { extractAudio: true, audioFormat: 'mp3' } : { mergeOutputFormat: 'mp4' }),
                print: 'after_move:filepath'
            });
            const output_lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            temp = output_lines.at(-1);
            file_name = path.basename(temp);
            data.mimetype = media === 'audio' ? 'audio/mpeg' : 'video/mp4';
        } else if (type === 'movie') {
            //TODO: Add channel database ID and replace `<channel-id>`
            if (!process.env.TG_API_ID || !process.env.TG_API_HASH || !process.env.TG_SESSION) throw new Error("Required env data not provided");
            recache();
            const client = new TelegramClient(new StringSession(process.env.TG_SESSION), Number(process.env.TG_API_ID), process.env.TG_API_HASH, { connectionRetries: 5 });
            const search = query.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            if (!search) throw new Error("Invalid search query");
            let index = cache.movies;
            if (!index.size) {
                for await (const msg of client.iterMessages("<channel-id>")) {
                    if (!msg.media) continue;
                    let name = '';
                    if (msg.media.document) {
                        const attributes = msg.media.document.attributes || [];
                        const attr = attributes.find(a => a.fileName);
                        if (attr) name = attr.fileName;
                    }
                    if (!name) continue;
                    if (['mkv', 'mp4', 'avi', 'mov'].some(r => !name.toLowerCase().endsWith(`.${r}`))) continue;
                    const title = name.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').replace(/\b(WEB[- ]?DL|WEBRip|BluRay|BRRip|BDRip|HDRip|DVDRip|HDTV|CAM|TS|TC|480p|576p|720p|1080p|2160p|4k|8k|x264|x265|h264|h265|HEVC|10bit|AAC|AC3|DTS|Pahe\.in|Pahe|YTS|RARBG|PSA|EVO|EMTV)\b/gi, '').replace(/\.(mkv|mp4|avi|mov)$/i, '').trim();
                    if (!title) continue;
                    cache.movies.set(title.replace(/[^a-z0-9]+/gi, ' ').trim(), { title, messageId: msg.id, filename: name });
                }
                cache.expires = Date.now() + (1000 * 60 * 60 * 3);
                fs.writeFileSync(path.join(cache_path), JSON.stringify(cache));
            }
            let movie = null;
            if (index.has(search)) movie = index.get(search);
            else {
                //TODO: advanced search for movie
            }
            if (!movie) throw new Error("No movies found in database.");
            const messages = await client.getMessages("<channel-id>", { ids: movie.messageId });
            const message = messages[0];
            if (!message.media) throw new Error("No media contained for this item in the movie database");
            file_name = movie.filename.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
            temp = path.join(os.tmpdir(), `movie_${Date.now()}_${file_name}`);
            await client.downloadMedia(message, { outputFile: temp });
            const ext = path.extname(movie.filename).slice(1).toLowerCase();
            data.mimetype = ext === 'mkv' ? 'video/x-matroska' : ext === 'avi' ? 'video/x-msvideo' : ext === 'mov' ? 'video/quicktime' : 'video/mp4';
            data.title = movie.title;
        } else throw new Error('Unsupported download type');
        if (!temp || !fs.existsSync(temp)) throw new Error('Failed to prepare media file');
        const stats = fs.statSync(temp);
        data.size = stats.size;
        const formData = new Form_Data();
        // TODO: Replace catbox with another API
        formData.append("reqtype", "fileupload");
        formData.append("time", "24h");
        formData.append("fileToUpload", fs.createReadStream(temp), { filename: file_name, contentType: data.mimetype });
        const response = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", formData, { headers: formData.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
        data.url = response.data.trim();
        data.expires = Date.now() + (1000 * 60 * 60 * 2);
        // TODO: Replace catbox with another API
        res.json({ ...data });
    } catch (error) {
        console.error(error.message);
        res.status(400).json({ error: error.message || 'Internal Server Error' });
    } finally {
        if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
});

app.post('api/upload', upload.single('image'), async (req, res) => {
    const file = req.file;
    const data = { mode: 'upload', mimetype: '', url: '', size: 0 };
    try {
        if (!process.env.IMGBB_API_KEY) throw new Error('Required environment variable is missing.');
        if (!file) throw new Error('No image file uploaded');
        const stats = fs.statSync(file.path);
        data.size = stats.size;
        //FIXME: IMGBB upload error
        const base64 = fs.readFileSync(file.path, { encoding: '' });
        const params = new URLSearchParams();
        params.append('image', base64);
        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, params);
        //FIXME: IMGBB upload error
        const img = response.data.data;
        data.mimetype = img.image.mime;
        data.url = img.display_url;
        res.json({ ...data });
    } catch (error) {
        console.error(error.message);
        res.status(400).json({ error: error.message || 'Internal Server Error' });
    } finally {
        if (fs.existsSync(file?.path)) fs.unlinkSync(file?.path);
    }
});

function recache() {
    const local = JSON.parse(fs.readFileSync(cache_path));
    if (Date.now() >= local?.expires) return;
    else cache = local;
}

export default app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));