import express from 'express';
import cors from "cors";
import axios from 'axios';
import yts from 'yt-search';
import { TelegramClient } from "telegram";
import FormData from 'form-data';
// import { StringSession } from "telegram/sessions/index.ts";

const app = express();

app.use(express.json());
app.use(cors());

app.get('/api', (req, res) => res.json({ message: "API is up and running!" }));
app.get('/api/:mode/:type/:query', async (req, res) => {
    try {
        const { mode, type, query } = req.params;
        const data = { mode, type, query, result: null };
        if (mode === 'search') {
            if (type === 'music') {
                const response = await axios.get(`https://api.deezer.com/search?q=${query}`);
                if (!response.data) throw new Error('No music found');
                data.result = response.data.data.map(itm => ({ id: itm.id, title: itm.title, preview: itm.preview, thumbnail: itm.album.cover, artist: itm.artist.name, album: itm.album.title }));
            } else if (type === 'yt') {
                const search = await yts(query);
                if (!search || !search.videos.length) throw new Error('No media found!');
                data.result = search.videos.map(itm => ({ id: itm.videoId, title: itm.title, author: itm.author.name, url: itm.url, thumbnail: itm.thumbnail, description: itm.description }));
            } else if (type === 'movie') {
                const response = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: process.env.TMDB_API_KEY, query: query } });
                if (!response.data) throw new Error('No movies found');
                data.result = response.data.results.map(movie => ({ id: movie.id, title: movie.title, overview: movie.overview, release_date: movie.release_date, rating: movie.vote_average, poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null }));
            } else throw new Error(`Invalid parameters`);
        } else if (mode === 'download') {
            const media = { buffer: null, file_name: '', mimetype: '', size: 0 };
            if (['audio', 'video'].includes(type)) {
                
            } else if (type === 'movie') {
                
            } else throw new Error(`Invalid parameters`);
            const { buffer, file_name, mimetype, size } = media;
            if (!buffer) throw new Error('No media received');
            const formData = new FormData();
            formData.append("reqtype", "fileupload");
            formData.append("time", "24h");
            formData.append("fileToUpload", buffer, { filename: file_name || 'file', contentType: mimetype });
            const response = await axios.post("https://litterbox.catbox.moe/resources/internals/api.php", formData, { headers: formData.getHeaders() });
            data.result = { url: response.data, expires: "24h", title: file_name || query, size: size };
        } else throw new Error('Bad request');
        res.json({ success: true, data });
    } catch (error) {
        console.log(error.message);
        res.status(500).json(error.message);
    }
});

export default app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));