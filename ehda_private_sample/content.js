// content-script.js
// Responsibilities:
// - Insert small download button at .glink titles and gallery header (#gd2 #gn/#gj).
// - On click: collect gallery info (title, galleryId, images[] full-size URLs) then send to background: { type: "ADD_TO_QUEUE", gallery: {...} }
// - Show small status span next to button; update on background messages (preparing/downloading/done/error)

(() => {
  const BTN_CLASS = 'ehdl-btn';
  const STATUS_CLASS = 'ehdl-status';
  const INSERT_ATTR = 'data-ehdl-inserted';
  const galleryHrefRegex = /^https?:\/\/(e-hentai\.org|exhentai\.org)\/g\/(\d+)\/([0-9a-fA-F]+)\/?$/;

  // styles
  const style = document.createElement('style');
  style.textContent = `
    .${BTN_CLASS} { display:inline-flex; align-items:center; justify-content:center; width:1.05em; height:1.05em; margin-right:6px; padding:0 4px; cursor:pointer; font-weight:700; font-size:14px; vertical-align:middle; border:none; background:transparent; }
    .${STATUS_CLASS} { margin-left:6px; font-size:13px; vertical-align:middle; color:#64748b; }
    .ehdl-status-preparing::after { content: "⏳"; margin-left:4px; }
    .ehdl-status-downloading::after { content: "🔄"; margin-left:4px; }
    .ehdl-status-done::after { content: "✅"; margin-left:4px; color:#7fff00; }
    .ehdl-status-error::after { content: "✖"; margin-left:4px; color:#ff5555; }
  `;
  document.head.appendChild(style);

  function isStrictGallery(href) {
    if (!href) return false;
    const u = href.split('?')[0];
    return galleryHrefRegex.test(u);
  }
  function normalize(href) {
    try {
      const u = new URL(href, location.href);
      const m = u.pathname.match(/\/g\/(\d+)\/([0-9a-fA-F]+)\/?/);
      if (m) return { normalized: `${u.protocol}//${u.hostname}/g/${m[1]}/${m[2]}/`, galleryId: m[1] };
    } catch (e) {}
    return null;
  }

  function createBtn() {
    const b = document.createElement('button');
    b.className = BTN_CLASS;
    b.type = 'button';
    b.textContent = '⬇';
    b.title = 'ダウンロード';
    return b;
  }
  function createStatus() {
    const s = document.createElement('span');
    s.className = STATUS_CLASS;
    return s;
  }

  // Insert into list page (anchors that contain .glink)
  function insertListButtons() {
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      if (!isStrictGallery(a.href)) return false;
      if (!a.querySelector('.glink')) return false;
      // avoid pager by parent check
      if (a.closest('.ptt') || a.closest('.ptb')) return false;
      return true;
    });

    anchors.forEach(a => {
      if (a.getAttribute(INSERT_ATTR)) return;
      const titleDiv = a.querySelector('.glink');
      if (!titleDiv) return;
      const norm = normalize(a.href);
      if (!norm) return;
      const btn = createBtn();
      const status = createStatus();
      btn._gallery = { normalized: norm.normalized, galleryId: norm.galleryId, title: titleDiv.innerText.trim() };

      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        btn.disabled = true;
        status.className = STATUS_CLASS + ' ehdl-status-preparing';
        try {
          const info = await collectGalleryImages(norm.normalized);
          if (!info || !info.images || info.images.length === 0) {
            status.className = STATUS_CLASS + ' ehdl-status-error';
            btn.disabled = false;
            return;
          }
          chrome.runtime.sendMessage({ type: 'ADD_TO_QUEUE', gallery: info }, (resp) => {
            // keep preparing until background updates
            btn.disabled = false;
          });
        } catch (err) {
          console.error(err);
          status.className = STATUS_CLASS + ' ehdl-status-error';
          btn.disabled = false;
        }
      });

      titleDiv.insertBefore(btn, titleDiv.firstChild);
      titleDiv.insertBefore(status, btn.nextSibling);
      a.setAttribute(INSERT_ATTR, '1');
    });
  }

  // Insert into gallery header
  function insertHeaderButton() {
    const norm = normalize(location.href);
    if (!norm) return;
    const gd2 = document.getElementById('gd2');
    if (!gd2) return;
    if (gd2.getAttribute(INSERT_ATTR)) return;
    const titleNode = gd2.querySelector('#gn') || gd2.querySelector('#gj') || gd2.querySelector('h1');
    if (!titleNode) { gd2.setAttribute(INSERT_ATTR, '1'); return; }

    const btn = createBtn();
    const status = createStatus();
    btn._gallery = { normalized: norm.normalized, galleryId: norm.galleryId, title: titleNode.innerText.trim() };

    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.disabled = true;
      status.className = STATUS_CLASS + ' ehdl-status-preparing';
      try {
        const info = await collectGalleryImages(norm.normalized);
        if (!info || !info.images || info.images.length === 0) {
          status.className = STATUS_CLASS + ' ehdl-status-error';
          btn.disabled = false;
          return;
        }
        chrome.runtime.sendMessage({ type: 'ADD_TO_QUEUE', gallery: info }, (resp) => {
          btn.disabled = false;
        });
      } catch (err) {
        console.error(err);
        status.className = STATUS_CLASS + ' ehdl-status-error';
        btn.disabled = false;
      }
    });

    titleNode.insertBefore(btn, titleNode.firstChild);
    titleNode.insertBefore(status, btn.nextSibling);
    gd2.setAttribute(INSERT_ATTR, '1');
  }

  // collect gallery images: fetch gallery pages, collect thumbnails -> view pages -> #img src
  async function collectGalleryImages(galleryUrl) {
    // fetch main gallery
    const r0 = await fetch(galleryUrl, { credentials: 'include' });
    if (!r0.ok) throw new Error('failed to fetch gallery');
    const html0 = await r0.text();
    const doc0 = new DOMParser().parseFromString(html0, 'text/html');

    const title = (doc0.querySelector('#gn')?.innerText || doc0.querySelector('#gj')?.innerText || document.title || '').trim();
    let totalPages = 0;
    const ptt = doc0.querySelector('.ptt');
    if (ptt) {
      Array.from(ptt.querySelectorAll('a[href]')).forEach(a => {
        try {
          const u = new URL(a.href, galleryUrl);
          const p = u.searchParams.get('p');
          if (p !== null) {
            const n = parseInt(p, 10);
            if (!isNaN(n) && n > totalPages) totalPages = n;
          }
        } catch(e){}
      });
    }

    const viewLinks = [];
    for (let p = 0; p <= totalPages; p++) {
      const pageUrl = galleryUrl + (p === 0 ? '' : `?p=${p}`);
      const rp = await fetch(pageUrl, { credentials: 'include' });
      if (!rp.ok) continue;
      const pageHtml = await rp.text();
      const pd = new DOMParser().parseFromString(pageHtml, 'text/html');
      // thumbnails: .gdtm a or .gdtl a
      const thumbs = pd.querySelectorAll('.gdtm a, .gdtl a');
      thumbs.forEach(a => { if (a && a.href) viewLinks.push(a.href); });
      await sleep(60);
    }

    const images = [];
    for (const viewUrl of viewLinks) {
      try {
        const rv = await fetch(viewUrl, { credentials: 'include' });
        if (!rv.ok) { images.push(null); continue; }
        const viewHtml = await rv.text();
        const vd = new DOMParser().parseFromString(viewHtml, 'text/html');
        const img = vd.querySelector('#img');
        if (img && img.src) images.push(img.src);
        else {
          const imgs = Array.from(vd.querySelectorAll('img')).filter(i => i.src && /\.(jpe?g|png|gif)/i.test(i.src));
          images.push(imgs.length ? imgs[0].src : null);
        }
      } catch (e) {
        console.error('view fetch error', e);
        images.push(null);
      }
      await sleep(120);
    }

    const filtered = images.filter(Boolean);
    const gidMatch = galleryUrl.match(/\/g\/(\d+)\//);
    const galleryId = gidMatch ? gidMatch[1] : String(Date.now());
    return { title: sanitizeTitle(title || `gallery_${galleryId}`), galleryId, images: filtered, tabId: (location && chrome && chrome.runtime ? (chrome.runtime.id ? null : null) : null) };
  }

  function sanitizeTitle(s) { return String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150); }

  // listen background messages to update status spans
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (["DOWNLOAD_STATUS","DOWNLOAD_PROGRESS","DOWNLOAD_FINISHED","DOWNLOAD_ERROR","QUEUE_UPDATED"].includes(msg.type)) {
      updateStatusSpans(msg);
    }
  });

  function updateStatusSpans(msg) {
    // try to match by galleryId in button._gallery
    const allBtns = Array.from(document.querySelectorAll('.' + BTN_CLASS));
    allBtns.forEach(btn => {
      const g = btn._gallery || {};
      const statusSpan = btn.nextSibling && btn.nextSibling.classList && btn.nextSibling.classList.contains(STATUS_CLASS) ? btn.nextSibling : null;
      if (!statusSpan) return;
      if (g.galleryId && msg.galleryId && String(g.galleryId) === String(msg.galleryId)) {
        // apply status
        statusSpan.className = STATUS_CLASS; // reset
        if (msg.type === 'DOWNLOAD_STATUS' && msg.status === 'preparing') statusSpan.classList.add('ehdl-status-preparing');
        if (msg.type === 'DOWNLOAD_STATUS' && msg.status === 'downloading') statusSpan.classList.add('ehdl-status-downloading');
        if (msg.type === 'DOWNLOAD_PROGRESS') statusSpan.classList.add('ehdl-status-downloading');
        if (msg.type === 'DOWNLOAD_FINISHED') statusSpan.classList.add('ehdl-status-done');
        if (msg.type === 'DOWNLOAD_ERROR') statusSpan.classList.add('ehdl-status-error');
      }
    });
  }

  // init
  function init() {
    insertListButtons();
    insertHeaderButton();
    const mo = new MutationObserver(() => { insertListButtons(); insertHeaderButton(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  try { init(); } catch (e) { console.error('content init error', e); }
})();
