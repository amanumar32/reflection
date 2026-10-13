# Reflection

**Reflection** is an open-source Express.js API for searching media metadata, processing YouTube audio/video downloads, and uploading images. It provides a small HTTP interface over third-party services.

**Maintained by [Halo Studios](https://halostudios.xyz).**  
**Repository:** https://github.com/amanumar32/reflection

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Run the API](#run-the-api)
- [Endpoints](#endpoints)
  - [Health check](#1-health-check)
  - [Search](#2-search)
  - [Download YouTube media](#3-download-youtube-media)
  - [Upload an image](#4-upload-an-image)
- [Errors](#errors)
- [Operational notes and limitations](#operational-notes-and-limitations)
- [Legal and responsible use](#legal-and-responsible-use)
- [License](#license)

## Features

- Search music using Deezer.
- Search YouTube videos.
- Search movies using The Movie Database (TMDB).
- Process a YouTube video as MP4 video or MP3 audio and return a temporary direct URL.
- Upload images through ImgBB.
- JSON responses and standard HTTP status codes for errors.

## Requirements

- Node.js **20 or later** recommended.
- npm.
- `ffmpeg` installed and available on `PATH` for audio extraction and media merging.
- API keys for the providers used by the relevant endpoints:
  - TMDB: movie search.
  - ImgBB: image upload.

YouTube downloads depend on YouTube and `yt-dlp` availability and may be affected by upstream restrictions, network conditions, or platform changes.

## Installation

```bash
git clone https://github.com/amanumar32/reflection.git
cd reflection
npm install
```

The project imports the following runtime packages: `express`, `cors`, `axios`, `yt-search`, `youtube-dl-exec`, `multer`, and `p-queue`. Make sure the repository's `package.json` defines the required dependencies and uses ES modules.

## Configuration

Set the environment variables for the endpoints you intend to use:

| Variable | Required for | Description |
| --- | --- | --- |
| `TMDB_API_KEY` | Movie search | API key used to query TMDB. |
| `IMGBB_API_KEY` | Image upload | API key used to upload images to ImgBB. |
| `PORT` | Optional | Port the server listens on. Defaults to `8080`. |

For local development, you can create a `.env` file, but the current source code does **not** load `.env` files automatically. Supply variables through your shell, deployment environment, or a Node version that supports `--env-file`.

Example `.env`:

```dotenv
TMDB_API_KEY=your_tmdb_api_key
IMGBB_API_KEY=your_imgbb_api_key
PORT=8080
```

On a recent Node.js version, you can load that file with:

```bash
node --env-file=.env app.js
```

Do not commit real API keys or other secrets to source control.

## Run the API

Start the server using your project's configured start script, if available. Otherwise, if the entry point is `app.js`:

```bash
node --env-file=.env app.js
```

The default base URL for local development is `http://localhost:8080`.

## Endpoints

All responses shown below are illustrative examples. IDs, URLs, metadata, and result counts will vary depending on the upstream service and the query.

### 1. Health check

`GET /api`

Checks whether the API server is responding.

**Example request**

```http
GET /api
```

**Example response — `200 OK`**

```json
{
  "message": "API is up and running!"
}
```

### 2. Search

`GET /api/search/:type?query=...`

Searches a supported media catalogue. The `query` value should be URL-encoded when it contains spaces or special characters.

**Path parameter**

| Parameter | Accepted values | Description |
| --- | --- | --- |
| `type` | `music`, `yt`, `movie` | Selects the search provider and result format. |

**Query parameters**

| Parameter | Required | Description |
| --- | --- | --- |
| `query` | Yes | Search terms, such as a song title, artist, YouTube video, or movie title. |

#### Search types

- `music` — searches Deezer.
- `yt` — searches YouTube videos.
- `movie` — searches TMDB. Requires `TMDB_API_KEY`.

#### Example: music search

```http
GET /api/search/music?query=Daft%20Punk
```

**Example response — `200 OK`**

```json
{
  "mode": "search",
  "type": "music",
  "query": "Daft Punk",
  "results": [
    {
      "id": 123456,
      "title": "Example Track",
      "preview": "https://example.com/preview.mp3",
      "thumbnail": "https://example.com/album-cover.jpg",
      "artist": "Example Artist",
      "album": "Example Album"
    }
  ],
  "length": 1
}
```

Each music result contains `id`, `title`, `preview`, `thumbnail`, `artist`, and `album`. The `preview` field is supplied by Deezer and may be empty or unavailable for some tracks.

#### Example: YouTube search

```http
GET /api/search/yt?query=lofi%20music
```

**Example response — `200 OK`**

```json
{
  "mode": "search",
  "type": "yt",
  "query": "lofi music",
  "results": [
    {
      "id": "abcdefghijk",
      "title": "Example YouTube Video",
      "author": "Example Channel",
      "url": "https://www.youtube.com/watch?v=abcdefghijk",
      "thumbnail": "https://example.com/thumbnail.jpg",
      "description": "Example video description"
    }
  ],
  "length": 1
}
```

Each YouTube result contains `id`, `title`, `author`, `url`, `thumbnail`, and `description`.

#### Example: movie search

```http
GET /api/search/movie?query=Inception
```

**Example response — `200 OK`**

```json
{
  "mode": "search",
  "type": "movie",
  "query": "Inception",
  "results": [
    {
      "id": 27205,
      "title": "Inception",
      "overview": "Example movie overview.",
      "release_date": "2010-07-16",
      "rating": 8.4,
      "poster": "https://image.tmdb.org/t/p/w500/example.jpg"
    }
  ],
  "length": 1
}
```

Each movie result contains `id`, `title`, `overview`, `release_date`, `rating`, and `poster`. `poster` is `null` when TMDB does not provide a poster path.

### 3. Download YouTube media

`GET /api/download/:type?query=...&media=...`

Searches for or accepts a YouTube URL, processes the selected media, uploads the resulting file to a temporary file host, and returns a URL to the hosted file.

**Path parameter**

| Parameter | Accepted values | Description |
| --- | --- | --- |
| `type` | `yt` | The only download type currently implemented. |

**Query parameters**

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `query` | Yes | — | A YouTube URL/video link or search phrase. Search phrases resolve to the first YouTube search result. |
| `media` | No | `video` | `video` returns MP4 video; `audio` extracts MP3 audio. |

#### Example: download video

```http
GET /api/download/yt?query=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dabcdefghijk&media=video
```

**Example response — `200 OK`**

```json
{
  "mode": "download",
  "type": "yt",
  "query": "https://www.youtube.com/watch?v=abcdefghijk",
  "media": "video",
  "title": "",
  "thumbnail": "",
  "mimetype": "video/mp4",
  "size": 12345678,
  "url": "https://files.example.com/example.mp4",
  "expires": 1790000000000
}
```

#### Example: download audio

```http
GET /api/download/yt?query=artist%20song%20name&media=audio
```

**Example response — `200 OK`**

```json
{
  "mode": "download",
  "type": "yt",
  "query": "artist song name",
  "media": "audio",
  "title": "Example Song",
  "thumbnail": "https://example.com/thumbnail.jpg",
  "mimetype": "audio/mpeg",
  "size": 3456789,
  "url": "https://files.example.com/example.mp3",
  "expires": 1790000000000
}
```

**Response fields**

- `mode`, `type`, `query`, `media`: describe the request.
- `title`, `thumbnail`: metadata found during search. These may be empty when a direct YouTube URL is supplied.
- `mimetype`: `video/mp4` for video or `audio/mpeg` for audio.
- `size`: resulting file size in bytes.
- `url`: hosted media URL returned by the temporary file provider.
- `expires`: Unix timestamp in **milliseconds** indicating the expected expiration time.

Temporary hosting is provided through Litterbox, with Tmpfiles used as a fallback. Availability, expiry, and direct-link behavior depend on those third-party services; do not treat the URL as permanent storage.

### 4. Upload an image

`POST /api/upload/image`

Uploads an image to ImgBB. This endpoint expects a `multipart/form-data` request with the file field named **`image`**.

**Query parameters:** none.

**Required configuration:** `IMGBB_API_KEY`.

#### Example request

```bash
curl -X POST http://localhost:8080/api/upload/image \
  -F "image=@./picture.jpg"
```

**Example response — `200 OK`**

```json
{
  "mode": "upload",
  "mimetype": "image/jpeg",
  "url": "https://i.ibb.co/example/picture.jpg",
  "size": 456789,
  "expires": null
}
```

The example's `url` is the display URL returned by ImgBB. In the current implementation, `expires` is set to `Infinity` in JavaScript; JSON serialization represents non-finite numeric values as `null`.

Although `/api/upload/:type` accepts a `type` path segment, only `image` is supported. The `file` type is explicitly rejected in this version.

## Errors

Errors are returned as JSON with an `error` message.

**Example — missing `query` (`400 Bad Request`)**

```json
{
  "error": "Query parameter is required"
}
```

**Example — unsupported type (`400 Bad Request`)**

```json
{
  "error": "Invalid type parameter"
}
```

Common error cases include:

| HTTP status | Meaning / example |
| --- | --- |
| `400` | Missing required query/file, unsupported search or download type, or unsupported upload type. |
| `404` | No media found for a search. |
| `500` | Unexpected server/provider failure, missing required environment configuration, or a media processing/upload failure. |

The exact error message depends on the endpoint and the upstream service. Some upstream failures may be returned as `500`.

## Operational notes and limitations

- **Temporary files:** Downloaded media is uploaded to an external temporary host; it is not stored permanently by Reflection.
- **Download size:** The upload helper rejects files larger than **100 MB**.
- **Concurrency:** Download processing is queued with a concurrency limit of **one** task at a time.
- **Third-party dependencies:** Search, downloading, and hosting rely on external services that may change, rate-limit requests, or become unavailable.
- **YouTube access:** Downloads may fail when YouTube blocks a request or requires additional verification.
- **Image upload:** Requires a valid ImgBB API key.
- **File upload:** General file uploads are not supported by the current `/api/upload/file` implementation.
- **Production hardening:** Configure suitable rate limits, request logging, monitoring, and deployment-level safeguards before exposing an instance publicly. CORS is enabled in the current source.

## Legal and responsible use

Reflection is an open-source media-handling utility. **It does not promote, endorse, or encourage illegal activity, copyright infringement, or the distribution of pirated content.** It is intended for lawful media discovery, metadata retrieval, personal use where permitted, and developer experimentation.

Users are responsible for obtaining any permissions required to access, download, store, or redistribute media and for complying with applicable laws, copyright rules, and third-party platform terms. The availability of an endpoint does not grant rights to any content returned by it. Halo Studios does not authorize unlawful use of the project.

## License

No license has been specified in this README. Before presenting Reflection as open source for reuse, distribution, or modification, add a `LICENSE` file and update this section to identify the chosen license.
