# Tape Reading Academy

A self-contained web learning portal for tape reading, time & sales, order flow, and market microstructure.

## Deployment

This is a static HTML site. No Node.js, npm, or build step is required.

### GitHub Pages
- Deploy the repository from the `main` branch.
- Set the Pages folder to `/ (root)`.
- The site entry point is `index.html`.

### Vercel
Import the GitHub repository into Vercel.
- Framework: Other / Static
- Build command: none
- Output directory: `.`
- The included `vercel.json` provides basic static-site configuration.

## Local preview

Open `index.html` directly in a browser, or run a simple local server:

```bash
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Videos

Place lesson video files in the `videos/` directory using the filenames expected by the site. Avoid committing individual files larger than GitHub's per-file limit; use external video hosting or Git LFS for large media.
