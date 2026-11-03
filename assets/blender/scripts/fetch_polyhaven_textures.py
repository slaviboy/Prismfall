"""Downloads Poly Haven PBR textures (CC0) into assets/external/polyhaven/<id>/ with a source.json.

Plain Python (no Blender needed). Files whose MD5 already matches the API are skipped.

Usage: python assets/blender/scripts/fetch_polyhaven_textures.py <id> [<id> ...] [--res 2k] [--maps Diffuse,nor_gl,arm,Displacement]

The Lost Kingdom's Blender build (lost_kingdom.py) reads these maps; see ASSET_LICENSES.md.
"""
import datetime
import hashlib
import json
import os
import sys
import urllib.request

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
API = "https://api.polyhaven.com"
SHORT = {"Diffuse": "diffuse", "nor_gl": "nor_gl", "arm": "arm", "Displacement": "disp", "Rough": "rough", "AO": "ao"}


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "prismfall-asset-pipeline"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


def main() -> None:
    argv = sys.argv[1:]
    res = "2k"
    maps = ["Diffuse", "nor_gl", "arm", "Displacement"]
    ids = []
    i = 0
    while i < len(argv):
        if argv[i] == "--res":
            res = argv[i + 1]
            i += 2
        elif argv[i] == "--maps":
            maps = argv[i + 1].split(",")
            i += 2
        else:
            ids.append(argv[i])
            i += 1
    for tid in ids:
        info = json.loads(get(f"{API}/info/{tid}"))
        files = json.loads(get(f"{API}/files/{tid}"))
        out = os.path.join(ROOT, "assets", "external", "polyhaven", tid)
        os.makedirs(out, exist_ok=True)
        record = []
        for m in maps:
            entry = files.get(m, {}).get(res, {}).get("jpg")
            if not entry:
                print(f"{tid}: no {m} {res} jpg")
                continue
            name = f"{tid}_{SHORT.get(m, m.lower())}_{res}.jpg"
            path = os.path.join(out, name)
            if not (os.path.exists(path) and hashlib.md5(open(path, "rb").read()).hexdigest() == entry["md5"]):
                data = get(entry["url"])
                if hashlib.md5(data).hexdigest() != entry["md5"]:
                    raise RuntimeError(f"MD5 mismatch for {entry['url']}")
                with open(path, "wb") as f:
                    f.write(data)
                print(f"downloaded {name}")
            record.append({"path": name, "url": entry["url"], "md5": entry["md5"], "size": entry["size"]})
        src_path = os.path.join(out, "source.json")
        previous = {}
        if os.path.exists(src_path):
            previous = json.load(open(src_path, encoding="utf-8"))
        known = {f["path"]: f for f in previous.get("files", [])}
        for f in record:
            known[f["path"]] = f
        source = {
            "id": tid,
            "kind": "texture",
            "name": info.get("name", tid),
            "page": f"https://polyhaven.com/a/{tid}",
            "api": {"info": f"{API}/info/{tid}", "files": f"{API}/files/{tid}"},
            "authors": info.get("authors", {}),
            "licence": "CC0 1.0",
            "licenceUrl": "https://polyhaven.com/license",
            "files": sorted(known.values(), key=lambda f: f["path"]),
            "downloaded": previous.get("downloaded", datetime.date.today().isoformat()),
        }
        with open(src_path, "w", encoding="utf-8", newline="") as f:
            f.write(json.dumps(source, indent=2) + "\n")
        print(f"{tid}: {len(record)} maps by {', '.join(source['authors'])}")


if __name__ == "__main__":
    main()
