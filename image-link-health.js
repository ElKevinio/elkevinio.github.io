// Load images without canvas/CORS access: a protected but displayable image is healthy.
(function (root) {
  function getReferences(items) {
    const refs = [];
    for (const item of items || []) {
      const design = item.vinylDesign;
      if (!design) continue;
      const add = (url, kind) => {
        if (typeof url === 'string' && /^https?:\/\//i.test(url)) refs.push({itemId:item.id,title:item.title || 'Ohne Titel',artist:item.artist || '',url,kind});
      };
      if (design.discStyle === 'picture-disc' && !design.cdImageDataUrl) add(design.cdImageUrl || item.coverUrl, 'Picture Disc');
      (design.records || []).forEach((record, index) => {
        (record.labelLayers || []).forEach(layer => {
          if (layer.type === 'Label' && !layer.logoDataUrl) add(layer.logoUrl, `Label · LP ${index+1}`);
        });
      });
    }
    return refs;
  }
  function probe(url, timeoutMs = 15000) {
    return new Promise(resolve => {
      const img = new root.Image();
      let timer;
      let done = false;
      const finish = result => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        img.onload = img.onerror = null;
        resolve(result);
      };
      img.onload = () => finish('ok');
      img.onerror = () => finish('error');
      img.referrerPolicy = 'no-referrer';
      timer = setTimeout(() => finish('unknown'), timeoutMs);
      img.src = url;
    });
  }
  root.VinylImageLinks = {getReferences, probe};
})(typeof window === 'undefined' ? globalThis : window);
