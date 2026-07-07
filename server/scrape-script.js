const sku = SKU_PLACEHOLDER;
try {
  const task = await useOrCreateTaskSpace('qh-scrape');

  // Try to reuse existing ozon.ru tab or navigate
  const tabs = await listTabs();
  let ozonTab = null;
  for (const t of tabs) {
    if (t.url && t.url.includes('ozon.ru')) { ozonTab = t; break; }
  }

  if (!ozonTab) {
    // No existing ozon.ru tab - try to create one
    await openOrReuseTab('https://www.ozon.ru/', { wait: true, timeout: 30 });
  }

  // Product IDs usually work directly. Search redirect is kept as fallback below.
  await js('window.location.href = "https://www.ozon.ru/product/' + sku + '/"');
  await new Promise(r => setTimeout(r, 7000));

  // Extract product data from the loaded page
  const data = await js(`(function() {
    var r = {};

    function visitJsonLd(node, cb) {
      if (!node) return;
      if (Array.isArray(node)) {
        node.forEach(function(child) { visitJsonLd(child, cb); });
        return;
      }
      if (typeof node !== 'object') return;
      cb(node);
      if (node['@graph']) visitJsonLd(node['@graph'], cb);
    }

    function readMeta(name) {
      var el = document.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
      return el ? (el.getAttribute('content') || '').trim() : '';
    }

    // 1. GET JSON-LD (most reliable)
    var ldEls = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < ldEls.length; i++) {
      try {
        var d = JSON.parse(ldEls[i].textContent);
        visitJsonLd(d, function(product) {
          var t = product['@type'];
          var isProduct = t === 'Product' || (Array.isArray(t) && t.indexOf('Product') >= 0);
          if (!isProduct) return;
          r.title = r.title || product.name || product.description || '';
          if (product.aggregateRating) {
            r.rating = r.rating || product.aggregateRating.ratingValue;
            r.reviewCount = r.reviewCount || product.aggregateRating.reviewCount;
          }
          r.brand = r.brand || (product.brand && (product.brand.name || product.brand)) || '';
          if (product.offers && !r.price) {
            var offer = Array.isArray(product.offers) ? product.offers[0] : product.offers;
            r.price = String(offer.price || offer.priceSpecification?.price || '');
            r.priceCurrency = offer.priceCurrency || '';
          }
          if (product.image && !r.primaryImage) {
            var imgs = Array.isArray(product.image) ? product.image : [product.image];
            r.images = imgs.slice(0,10);
            r.primaryImage = r.images[0];
          }
        });
      } catch(e) {}
    }

    // 2. Title from h1 (fallback)
    if (!r.title) {
      var h1 = document.querySelector('h1');
      r.title = h1 ? h1.textContent.trim() : '';
    }
    if (!r.title) r.title = readMeta('og:title').replace(/\\s*купить на OZON.*$/i, '').trim();
    if (!r.primaryImage) {
      var ogImage = readMeta('og:image');
      if (ogImage) {
        r.primaryImage = ogImage;
        r.images = [ogImage];
      }
    }
    if (!r.price) r.price = readMeta('product:price:amount') || readMeta('og:price:amount');

    // 3. Price from webPrice widget (fallback)
    if (!r.price) {
      var pw = document.querySelector('[data-widget="webPrice"], [data-widget="webPriceV2"]');
      if (pw) {
        try {
          var st = JSON.parse(pw.getAttribute('data-state') || '{}');
          if (st.price) r.price = typeof st.price === 'string' ? st.price : (st.price.value || st.price.text || '');
        } catch(e) {}
      }
    }

    // 4. Extract SKU from URL
    var pathParts = window.location.pathname.match(/-(\\d+)\\/?$/);
    r.sku = pathParts ? pathParts[1] : '${sku}';
    r.url = window.location.href;

    // 5. Try to get images from data-state if JSON-LD didn't have them
    if (!r.primaryImage) {
      try {
        var gallery = document.querySelector('[data-widget="webGallery"]');
        if (gallery) {
          var gs = JSON.parse(gallery.getAttribute('data-state') || '{}');
          var slides = gs.images || gs.slides || [];
          r.images = slides.map(function(s) { return typeof s === 'string' ? s : (s.src || s.url || ''); }).filter(Boolean);
          r.primaryImage = r.images[0] || '';
        }
      } catch(e) {}
    }

    return JSON.stringify(r);
  })()`);

  if (data && data.length > 20) {
    cliLog(data);
  } else {
    await js('window.location.href = "https://www.ozon.ru/search/?text=' + sku + '"');
    await new Promise(r => setTimeout(r, 7000));
    const fallback = await js(`(function() {
      var h1 = document.querySelector('h1');
      var title = h1 ? h1.textContent.trim() : '';
      var link = document.querySelector('a[href*="/product/"]');
      var img = document.querySelector('img[src*="ozonusercontent"], img[src*="ir.ozone"]');
      return JSON.stringify({
        sku: '${sku}',
        title: title,
        url: link ? new URL(link.getAttribute('href'), location.origin).href : location.href,
        primaryImage: img ? img.src : '',
        images: img ? [img.src] : []
      });
    })()`);
    if (fallback && fallback.length > 20) cliLog(fallback);
    else cliLog('SCRAPE_FAILED');
  }
} catch(e) {
  cliLog('FATAL: ' + e.message);
  cliLog('SCRAPE_FAILED');
}
