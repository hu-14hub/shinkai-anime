const UA = {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"};
const BASE = "https://api.consumet.ts";
const j = async (u) => (await fetch(u,{headers:UA})).json();
(async () => {
  const t0 = Date.now();
  try {
    const s = await j(`${BASE}/anime/gogoanime/demon slayer`);
    console.log("search keys:", Object.keys(s));
    const item = s.items?.[0];
    console.log("first item:", JSON.stringify(item));
    const id = item?.id;
    const w = await j(`${BASE}/anime/gogoanime/watch?episodeId=${id}`);
    console.log("watch keys:", Object.keys(w));
    console.log("sources count:", w.sources?.length);
    console.log("source[0]:", JSON.stringify(w.sources?.[0]));
    const url = w.sources?.[0]?.url;
    // m3u8 CORS check (GET with Origin)
    let m3 = null;
    try {
      const r2 = await fetch(url,{headers:{...UA, Origin:"http://localhost:3000"}});
      const txt = await r2.text();
      const lines = txt.split("\n").filter(Boolean);
      const hdr = {"access-control-allow-origin": r2.headers.get("access-control-allow-origin"), status: r2.status, content_type: r2.headers.get("content-type")};
      console.log("M3U8 header:", JSON.stringify(hdr));
      console.log("M3U8 first 6 lines:", JSON.stringify(lines.slice(0,6)));
      // check if segments absolute (http start) by looking for a file URL
      const seg = lines.find(l=>l.endsWith(".ts")||l.endsWith(".m4s")||/^https?:/.test(l));
      console.log("sample segment line:", seg);
      if (seg && seg.startsWith("http")) {
        const r3 = await fetch(seg,{headers:{...UA, Origin:"http://localhost:3000"}, method:"GET"});
        console.log("SEGMENT header:", {"access-control-allow-origin": r3.headers.get("access-control-allow-origin"), status: r3.status, content_type: r3.headers.get("content-type"), content_length: r3.headers.get("content-length")});
        r3.body?.cancel?.();
      }
    } catch(e){ console.log("M3U8ERR", e.message); }
  } catch(e){ console.log("PIPELINE ERR", e.message); }
  console.log("ELAPSED_MS", Date.now()-t0);
})();
