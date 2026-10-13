import express from 'express';
import cors from "cors";
import axios from 'axios';
import yts from 'yt-search';
import youtubeDl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';
import PQueue from 'p-queue';

const app = express();
app.use(express.json());
app.use(cors());

const configs = {
    max_process_limit: 1,
    max_file_size: 100 * 1024 * 1024, // 100 MB
}

const _upload = multer({ dest: os.tmpdir() });
const _queue = new PQueue({ concurrency: configs.max_process_limit });

async function upload_file(buffer = [], file_name = '', content = 'application/octet-stream') {
    let result = { url: '', expires: 0 };
    try {
        if (buffer.length > configs.max_file_size) throw new Error(`File size exceeds the maximum limit of ${configs.max_file_size / (1024 * 1024)} MB.`);
        const blob = new Blob([buffer], { type: content });
        try {
            const form = new FormData();
            form.append('reqtype', 'fileupload');
            form.append('time', '1h');
            form.append('fileToUpload', blob, file_name);
            const response = await axios.post('https://litterbox.catbox.moe/resources/internals/api.php', form, {
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
            });
            result.url = response.data;
            result.expires = Date.now() + (1000 * 60 * 60);
        } catch (error) { console.error("Failed to upload to Litterbox:", error.message) };
        if (!result.url) {
            try {
                const form = new FormData();
                form.append('file', blob, file_name);
                const response = await axios.post('https://tmpfiles.org/api/v1/upload', form, {
                    maxContentLength: Infinity,
                    maxBodyLength: Infinity,
                });
                const data = response.data;
                if (!data.data?.url) throw new Error('Upload failed');
                const text = await (await fetch(data.data.url)).text();
                const match = text.match(/https:\/\/tmpfiles\.org\/dl\/[^\s"']+/);
                result.url = match[0];
                result.expires = Date.now() + (1000 * 60 * 60);
            } catch (error) { console.error("Failed to upload to Tmpfiles:", error.message) }
        }
        if (!result.url) throw new Error('No data received from upload APIs');
        return result;
    } catch (error) {
        console.error("Failed to upload file:", error);
        throw error;
    }
}

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
        if (!query) throw new Error('Query parameter is required', { cause: 400 });
        const result = await _queue.add(async () => {
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
                const output_base = path.join(os.tmpdir(), `${Date.now()}_${(data.title || query).replace(/[^a-zA-Z0-9]/g, '_')}`);
                const cookies = path.join(process.cwd(), 'cookies.txt');
                await youtubeDl.exec(url, {
                    output: `${output_base}.%(ext)s`,
                    format: media === 'audio' ? 'bestaudio/best' : 'bestvideo*[height<=720]+bestaudio/best[height<=720]',
                    cookies: fs.existsSync(cookies) ? cookies : undefined,
                    jsRuntimes: 'node',
                    remoteComponents: 'ejs:github',
                    ...(media === 'audio' ? { extractAudio: true, audioFormat: 'mp3' } : { mergeOutputFormat: 'mp4' }),
                });
                const files = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith(path.basename(output_base)));
                if (!files.length) throw new Error('Downloaded file not found', { cause: 500 });
                temp = path.join(os.tmpdir(), files[0]);
                file_name = path.basename(temp);
                data.mimetype = media === 'audio' ? 'audio/mpeg' : 'video/mp4';
            } else throw new Error('Unsupported download type', { cause: 400 });

            if (!temp || !fs.existsSync(temp)) throw new Error('Failed to prepare media file', { cause: 500 });
            const stats = fs.statSync(temp);
            data.size = stats.size;
            const buffer = fs.readFileSync(temp);
            const uploaded = await upload_file(buffer, file_name, data.mimetype);
            data.url = uploaded.url;
            data.expires = uploaded.expires;
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

app.post('/api/upload/:type', _upload.single('image'), async (req, res) => {
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
            throw new Error('File upload is not supported in this version. Please use image upload instead.', { cause: 400 });
            const buffer = fs.readFileSync(file.path);
            const file_name = `${Date.now()}_${file.originalname || 'upload'}`;
            data.mimetype = file.mimetype || 'application/octet-stream';
            const uploaded = await upload_file(buffer, file_name, data.mimetype);
            data.url = uploaded.url;
            data.expires = uploaded.expires;
        } else throw new Error('Unsupported upload type', { cause: 400 });
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