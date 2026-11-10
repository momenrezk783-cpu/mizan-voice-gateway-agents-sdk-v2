// Shared accessible, DOM-only result renderer (no innerHTML with external text).
window.MizanSearch = {
  render(id, hits, message = 'لا توجد نتائج مطابقة.') {
    const root = document.getElementById(id);
    if (!root) return;
    root.replaceChildren();
    root.style.alignItems = 'stretch';
    root.style.textAlign = 'right';
    root.style.justifyContent = 'flex-start';
    if (!Array.isArray(hits) || !hits.length) {
      const p = document.createElement('p'); p.className = 'sub'; p.textContent = message; root.appendChild(p); return;
    }
    const count = document.createElement('p'); count.className = 'sub'; count.textContent = `عدد النتائج: ${hits.length} — بحث نصي في بياناتك الحالية`; root.appendChild(count);
    for (const hit of hits) {
      const card = document.createElement('article');
      card.className = 'search-hit';
      card.style.cssText = 'padding:14px;border:1px solid #E6EDF5;border-radius:12px;margin-top:9px;overflow-wrap:anywhere;width:100%';
      const title = document.createElement('strong'); title.textContent = hit.title || 'نتيجة بحث';
      const desc = document.createElement('p'); desc.className = 'sub'; desc.textContent = hit.detail || '';
      card.append(title, desc);
      root.appendChild(card);
    }
  }
};
