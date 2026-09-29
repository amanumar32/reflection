import express from 'express';
import cors from "cors";
import axios from 'axios';
import yts from 'yt-search';
import { TelegramClient } from "telegram";
// import { StringSession } from "telegram/sessions/index.ts";

const app = express();

app.use(express.json());
app.use(cors());

app.get('/api/:mode/:type/:query', async (req, res) => {
    try {
        const { mode, type, query } = req.params;
        let data = null;

        if (mode === 'search') {
            if (type === 'music') {
                const response = await axios.get(`https://api.deezer.com/search?q=${query}`);
                if (!response.data) throw new Error('No music found');
                data = { mode, type, query, result: response.data.data.map(itm => ({ id: itm.id, title: itm.title, preview: itm.preview, thumbnail: itm.album.cover, artist: itm.artist.name, album: itm.album.title })) };
            } else if (type === 'yt') {
                const search = await yts(query);
                if (!search || !search.videos.length) throw new Error('No media found!');
                data = { mode, type, query, result: search.videos.map(itm => ({ id: itm.videoId, title: itm.title, author: itm.author.name, url: itm.url, thumbnail: itm.thumbnail, description: itm.description })) };
            } else if (type === 'movie') {
                const response = await axios.get(`https://api.themoviedb.org/3/search/movie`, { params: { api_key: process.env.TMDB_API_KEY, query: query } });
                if (!response.data.results || response.data.results.length === 0) throw new Error('No movies found');
                data = { mode, type, query, result: response.data.results.map(movie => ({ id: movie.id, title: movie.title, overview: movie.overview, release_date: movie.release_date, rating: movie.vote_average, poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null })) };
            } else throw new Error(`Invalid parameters`);
        } else if (mode === 'download') {
            if (type === 'music') {
                data = { mode, type, query, result: "Music search placeholder" };
            } else if (type === 'yt') {
                data = { mode, type, query, result: "YouTube search placeholder" };
            } else if (type === 'movie') {
                data = { mode, type, query, result: "Movie search placeholder" };
            } else {
                throw new Error(`Invalid parameters`);
            }
        } else {
            throw new Error('Bad request');
        }

        res.json({ success: true, data });
    } catch (error) {
        console.log(error);
        res.status(400).json({ success: false, message: error.message });
    }
});

export default app;


// if (process.env.NODE_ENV !== 'production') app.listen(PORT, () => console.log(`Server running on http://localhost:${process.env.PORT || 3000}`));