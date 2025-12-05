// content-script.js (完全版)
// responsibilities:
// - Insert download button (single small emoji) into list items and gallery header (same-line).
// - On click: collect gallery info, enumerate view pages (thumbnails), fetch each view page, extract full image URLs (#img), then send ADD_TO_QUEUE to background with {title,galleryId,images}.
// - Listen to background status messages and update per-button status span (preparing/downloading/done/error).
// - Prevent pager links from receiving buttons (strict match).
(function() {
  const ATTR_INSERTED = 'data-ehdl-inserted';
  const BTN_CLASS = 'ehdl-btn';
  const STATUS_CLASS = 'ehdl-status';

  // css
  const style = document.createElement('style');
  style.textContent = `
    .${BTN_CLASS} { display:inline-flex; align-items:center; justify-content:center; width:1.05em; height:1.05em; margin-right:6px; padding:0 4px; cursor:pointer; font-weight:700; font-size:14px; vertical-align:middle; border:none; background:transparent; }
    .${STATUS_CLASS} { margin-left:6px; font-size:13px; color:#64748b; vertical-align:middle; }
    .ehdl-status-preparing::after { content: "⏳"; margin-left:6px; }
    .ehdl-status-downloading::after { content: "🔄"; margin-left:6px; }
    .ehdl-status-done::after { content: "✅"; margin-left:6px; color:#7fff00; }
    .ehdl-status-error::after { content: "✖"; margin-left:6px; color:#ff5555; };
    .${STATUS_CLASS} {transform: translateY(-1px);
}
  `;
  document.head.appendChild(style);

  // strict gallery URL detection
  const galleryHrefRegex = /^https?:\/\/(e-hentai\.org|exhentai\.org)\/g\/(\d+)\/([0-9a-fA-F]+)\/?$/;
  function isStrictGalleryUrl(href) {
    if (!href) return false;
    const u = href.split('?')[0];
    return galleryHrefRegex.test(u);
  }
  function normalizeGalleryUrl(href) {
    try {
      const u = new URL(href, location.href);
      const m = u.pathname.match(/\/g\/(\d+)\/([0-9a-fA-F]+)\/?/);
      if (m) return { origin: `${u.protocol}//${u.hostname}`, galleryId: m[1], hash: m[2], normalized: `${u.protocol}//${u.hostname}/g/${m[1]}/${m[2]}/` };
    } catch(e){}
    return null;
  }

  // create small button and status span
  function createButton() {
    const b = document.createElement('button');
    b.className = BTN_CLASS;
    b.textContent = '⬇';
    b.type = 'button';
    b.style.cursor = 'pointer';
    return b;
  }
  function createStatusSpan() {
    const s = document.createElement('span');
    s.className = STATUS_CLASS;
    return s;
  }

  // Insert into gallery list items (.glink)
  function insertIntoList() {
    // find anchor elements with .glink child and strict gallery href
    const anchors = Array.from(document.querySelectorAll('a[href]')).filter(a => {
      if (!isStrictGalleryUrl(a.href)) return false;
      // ensure it's not a pager anchor (pager has class pt* in parent)
      if (a.closest('.ptt') || a.closest('.ptb') || a.closest('.ptpb')) return false;
      // must contain .glink
      if (!a.querySelector('.glink')) return false;
      return true;
    });

    anchors.forEach(a => {
      if (a.getAttribute(ATTR_INSERTED)) return;
      const titleNode = a.querySelector('.glink');
      if (!titleNode) return;
      const norm = normalizeGalleryUrl(a.href);
      if (!norm) return;

      const btn = createButton();
      const status = createStatusSpan();
      btn._gallery = { normalized: norm.normalized, galleryId: norm.galleryId };

      btn.addEventListener('click', async (e) => {
        e.preventDefault(); e.stopPropagation();
        // disable button to prevent double click
        btn.disabled = true;
        status.className = STATUS_CLASS + ' ehdl-status-preparing';
        // collect images (thumbnails -> view pages -> full imgs)
        try {
          const galleryInfo = await collectGalleryImages(norm.normalized);
          if (!galleryInfo || !galleryInfo.images || galleryInfo.images.length === 0) {
            status.className = STATUS_CLASS + ' ehdl-status-error';
            btn.disabled = false;
            return;
          }
          // send to background
          chrome.runtime.sendMessage({ type: 'ADD_TO_QUEUE', gallery: galleryInfo }, (resp) => {
            // keep status as preparing until background signals
            btn.disabled = false;
          });
        } catch (err) {
          console.error('collect error', err);
          status.className = STATUS_CLASS + ' ehdl-status-error';
          btn.disabled = false;
        }
      });

      titleNode.insertBefore(btn, titleNode.firstChild);
      titleNode.insertBefore(status, btn.nextSibling);
      a.setAttribute(ATTR_INSERTED, '1');
    });
  }

  // Insert button into gallery page header (gd2 -> #gn / #gj)
  function insertIntoGalleryHeader() {
    const norm = normalizeGalleryUrl(location.href);
    if (!norm) return;
    const gd2 = document.getElementById('gd2');
    if (!gd2) return;
    if (gd2.getAttribute(ATTR_INSERTED)) return;
    const titleNode = gd2.querySelector('#gn') || gd2.querySelector('#gj') || gd2.querySelector('h1');
    if (!titleNode) { gd2.setAttribute(ATTR_INSERTED, '1'); return; }

    const btn = createButton();
    const status = createStatusSpan();

    btn.addEventListener('click', async (e) => {
      e.preventDefault(); e.stopPropagation();
      btn.disabled = true;
      status.className = STATUS_CLASS + ' ehdl-status-preparing';

      try {
        const galleryInfo = await collectGalleryImages(norm.normalized);
        if (!galleryInfo || !galleryInfo.images || galleryInfo.images.length === 0) {
          status.className = STATUS_CLASS + ' ehdl-status-error';
          btn.disabled = false;
          return;
        }
        chrome.runtime.sendMessage({ type: 'ADD_TO_QUEUE', gallery: galleryInfo }, (resp) => {
          btn.disabled = false;
        });
      } catch (err) {
        console.error('collect error', err);
        status.className = STATUS_CLASS + ' ehdl-status-error';
        btn.disabled = false;
      }
    });

    titleNode.insertBefore(btn, titleNode.firstChild);
    titleNode.insertBefore(status, btn.nextSibling);
    gd2.setAttribute(ATTR_INSERTED, '1');
  }

  // Collect gallery images: returns { title, galleryId, images: [fullImageUrls] }
  async function collectGalleryImages(galleryUrl) {
    // galleryUrl is normalized e.g. https://e-hentai.org/g/123456/abcdef/
    // 1) fetch gallery page HTML
    const resp = await fetch(galleryUrl, { credentials: 'include' });
    if (!resp.ok) throw new Error('Failed to fetch gallery page');
    const html = await resp.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // title
    let title = '';
    try { title = (doc.querySelector('#gn')?.innerText || doc.querySelector('#gj')?.innerText || doc.title || '').trim(); } catch(e){}

    // determine total pages
    let totalPages = 0;
    const ptt = doc.querySelector('.ptt');
    if (ptt) {
      const anchors = Array.from(ptt.querySelectorAll('a[href]'));
      anchors.forEach(a => {
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

    // For each gallery page (0..totalPages), collect thumbnail view links (.gdtm a / .gdtl a)
    const viewLinks = [];
    for (let p = 0; p <= totalPages; p++) {
      const pageUrl = galleryUrl + (p === 0 ? '' : `?p=${p}`);
      const r = await fetch(pageUrl, { credentials: 'include' });
      if (!r.ok) continue;
      const pageHtml = await r.text();
      const pageDoc = new DOMParser().parseFromString(pageHtml, 'text/html');
      const thumbs = Array.from(pageDoc.querySelectorAll('.gdtm a, .gdtl a'));
      thumbs.forEach(a => { if (a && a.href) viewLinks.push(a.href); });
      await new Promise(r => setTimeout(r, 80)); // throttle
    }

    // Now for each view link, fetch and extract full image URL (#img)
    const images = [];
    for (const viewUrl of viewLinks) {
      try {
        const r2 = await fetch(viewUrl, { credentials: 'include' });
        if (!r2.ok) { images.push(null); continue; }
        const viewHtml = await r2.text();
        const vdoc = new DOMParser().parseFromString(viewHtml, 'text/html');
        const imgEl = vdoc.querySelector('#img');
        if (imgEl && imgEl.src) {
          images.push(imgEl.src);
        } else {
          // fallback to first large img
          const imgs = Array.from(vdoc.querySelectorAll('img')).filter(i => i.src && /\.(jpe?g|png|gif)/i.test(i.src));
          if (imgs.length) images.push(imgs[0].src);
          else images.push(null);
        }
      } catch (e) {
        console.error('view fetch err', e);
        images.push(null);
      }
      await new Promise(r => setTimeout(r, 120));
    }

    // filter nulls but preserve order
    const filtered = images.filter(u => u && typeof u === 'string');

    // build galleryId from normalized url
    const m = galleryUrl.match(/\/g\/(\d+)\//);
    const galleryId = m ? m[1] : String(Date.now());

    return {
      title: sanitizeTitle(title || `gallery_${galleryId}`),
      galleryId,
      images: filtered
    };
  }

  // sanitize title for file system use
  function sanitizeTitle(s) {
    return s.replace(/[\\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);
  }

  // Listen background messages for status updates (so we can set status spans)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    if (msg.type === 'QUEUE_UPDATED') {
      // optional: update a small in-page queue indicator if desired
    }
    if (msg.type === 'DOWNLOAD_STATUS' || msg.type === 'DOWNLOAD_PROGRESS' || msg.type === 'DOWNLOAD_FINISHED' || msg.type === 'DOWNLOAD_ERROR') {
      const normalized = msg.galleryUrl || msg.galleryId ? null : null;
      // update status spans based on galleryId or title
      // For simplicity, we update any status spans that match title or galleryId where available
      updateAllStatusSpans(msg);
    }
  });

  function updateAllStatusSpans(msg) {
    // For simplicity, compare by title if provided, else by galleryId
    const byTitle = msg.title;
    const byId = msg.galleryId;
    const statusElems = Array.from(document.querySelectorAll('.' + STATUS_CLASS));
    statusElems.forEach(span => {
      const parent = span.previousSibling; // button usually
      if (!parent) return;
      const btn = parent;
      const g = btn._gallery || {};
      if (byId && g.galleryId && g.galleryId === byId) {
        applyStatus(span, msg);
      } else if (byTitle && g && g.normalized && g.normalized.includes(byTitle)) {
        applyStatus(span, msg);
      }
    });
  }

  function applyStatus(span, msg) {
    span.className = STATUS_CLASS; // reset
    if (msg.type === 'DOWNLOAD_STATUS' && msg.status === 'preparing') span.classList.add('ehdl-status-preparing');
    if (msg.type === 'DOWNLOAD_PROGRESS') span.classList.add('ehdl-status-downloading');
    if (msg.type === 'DOWNLOAD_FINISHED') span.classList.add('ehdl-status-done');
    if (msg.type === 'DOWNLOAD_ERROR') span.classList.add('ehdl-status-error');
  }

  // initialization
  function init() {
    insertIntoList();
    insertIntoGalleryHeader();
    const mo = new MutationObserver(() => { insertIntoList(); insertIntoGalleryHeader(); });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  try { init(); } catch (e) { console.error('content init error', e); }

})();
