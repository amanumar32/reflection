import express from 'express';
import cors from "cors";
import axios from 'axios';
import yts from 'yt-search';
import FormData from 'form-data';
import youtubeDl from 'youtube-dl-exec';
import fs from 'fs';
import path from 'path';
import os from 'os';
import multer from 'multer';

const app = express();

app.use(express.json());
app.use(cors());

const upload = multer({ dest: os.tmpdir() });

app.get('/api', (req, res) => res.json({ message: "API is up and running!" }));

app.all('/api/:mode/:type', upload.single('image'), async (req, res) => {
    try {
        const { mode, type } = req.params;
        const query = req.query.query;
        if (!query && mode !== 'upload') throw new Error('Query parameter is required');
        const data = { mode, type, query, result: null };
        if (mode === 'search') {
            if (type === 'music') {
                const response = await axios.get(`https://api.deezer.com/search?q=${encodeURIComponent(query)}`);
                if (!response.data) throw new Error('No music found');
                data.result = response.data.data.map(itm => ({ id: itm.id, title: itm.title, preview: itm.preview, thumbnail: itm.album.cover, artist: itm.artist.name, album: itm.album.title }));
            } else if (type === 'yt') {
                const search = await yts(query);
                if (!search || !search.videos.length) throw new Error('No media found!');
                data.result = search.videos.map(itm => ({ id: itm.videoId, title: itm.title, author: itm.author.name, url: itm.url, thumbnail: itm.thumbnail, description: itm.description }));
            } else if (type === 'movie') {
                const response = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: process.env.TMDB_API_KEY, query } });
                if (!response.data) throw new Error('No movies found');
                data.result = response.data.results.map(movie => ({ id: movie.id, title: movie.title, overview: movie.overview, release_date: movie.release_date, rating: movie.vote_average, poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null }));
            } else throw new Error(`Invalid type parameter`);
        } else if (mode === 'download') {
            let temp = null;
            let file_name = '';
            let content_type = '';
            if (['audio', 'video'].includes(type)) {
                let url = query;
                let title = query;
                const ext = type === 'audio' ? 'mp3' : 'mp4';
                if (!/(?:https?:\/\/)?(?:youtu\.be\/|(?:www\.|m\.)?youtube\.com\/(?:watch\?v=|v\/|embed\/|shorts\/|playlist\?list=)?)([a-zA-Z0-9_-]{11})/i.test(query)) {
                    const search = await yts(query);
                    if (!search || !search.videos.length) throw new Error('No media found!');
                    url = search.videos[0].url;
                    title = search.videos[0].title;
                }
                const output_base = path.join(os.tmpdir(), `${Date.now()}_${title.replace(/[^a-zA-Z0-9]/g, '_')}`);
                const result = await youtubeDl.exec(url, {
                    output: `${output_base}.%(ext)s`,
                    format: type === 'audio' ? 'bestaudio/best' : 'bestvideo*+bestaudio/best',
                    cookies: path.join(process.cwd(), 'cookies.txt'),
                    jsRuntimes: 'node',
                    ...(type === 'audio' ? { extractAudio: true, audioFormat: 'mp3' } : { mergeOutputFormat: 'mp4' }),
                    print: 'after_move:filepath'
                });
                const output_lines = result.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
                temp = output_lines.at(-1);
                if (!temp || !fs.existsSync(temp)) throw new Error(`Failed to prepare media file. yt-dlp output: ${result.stdout}`);
                file_name = path.basename(temp);
                content_type = type === 'audio' ? 'audio/mpeg' : 'video/mp4';
            } else if (type === 'movie') {
                throw new Error('Not implemented yet...');
            } else throw new Error('Unsupported download type');
            if (!temp || !fs.existsSync(temp)) throw new Error('Failed to prepare media file');
            try {
                const stats = fs.statSync(temp);
                const formData = new FormData();
                formData.append("reqtype", "fileupload");
                formData.append("time", "24h");
                formData.append("fileToUpload", fs.createReadStream(temp), { filename: file_name, contentType: content_type });
                const response = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", formData, { headers: formData.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity });
                data.result = { url: response.data.trim(), expires: "24h", title: file_name, size: stats.size };
            } finally {
                if (fs.existsSync(temp)) fs.unlinkSync(temp);
            }
        } else if (mode === 'upload') {
            try {
                if (!req.file) throw new Error('No image file uploaded');
                const formData = new FormData();
                formData.append('image', fs.createReadStream(req.file.path));
                const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, formData, { headers: formData.getHeaders() });
                if (!response.data || !response.data.success) throw new Error('ImgBB upload failed');
                const img = response.data.data;
                res.json({ data: { mode: 'upload', result: { url: img.url, display_url: img.display_url, delete_url: img.delete_url, size: img.size, mime: img.image.mime } } });
            } finally {
                if (fs.existsSync(req.file?.path)) fs.unlinkSync(req.file?.path);
            }
        }
        res.json({ data });
    } catch (error) {
        console.error(error.message);
        res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
});

export default app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));