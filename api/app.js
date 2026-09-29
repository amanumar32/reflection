import express from 'express';
import cors from "cors";

const app = express();

app.use(express.json());
app.use(cors());

app.get('/api/:mode/:type/:query', (req, res) => {
    try {
        const { mode, type, query } = req.params;
        let data = null;

        if (mode === 'search') {
            if (type === 'music') {
                data = { mode, type, query, result: "Music search placeholder" };
            } else if (type === 'yt') {
                data = { mode, type, query, result: "YouTube search placeholder" };
            } else if (type === 'movie') {
                data = { mode, type, query, result: "Movie search placeholder" };
            } else {
                throw new Error(`Invalid parameters`);
            }
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