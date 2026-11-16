# Atlas Globe

Interactive 3D Earth in the browser: map modes (natural, political, continents, population, density, GDP, income, live day & night), multi-country selection, and a NASA night-lights layer.

## Run locally

The page loads files with `fetch`, so open it through a local server, not by double-clicking:

```bash
python3 -m http.server 8000
# then open http://localhost:8000
```

## Deploy

GitHub Pages: Settings → Pages → Deploy from branch → `main`, folder `/ (root)`.

## Files

- `index.html`: the whole app (HTML, CSS, JS). D3 7.9.0 loads from cdnjs.
- `img/earth-night-full.jpg`: NASA Black Marble 2016, 13500×6750 (used when the GPU supports it)
- `img/earth-night.jpg`: same image at 8192×4096 (fallback for phones and weaker GPUs)
- `data/countries-50m.json`: detailed borders, loaded when zoomed in

## Data credits

- Countries, cities, rivers, lakes: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- Night lights: [NASA Earth Observatory, Black Marble 2016](https://earthobservatory.nasa.gov/features/NightLights) (public domain)
