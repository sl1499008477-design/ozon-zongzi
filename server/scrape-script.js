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
  let data = await js(`(function() {
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

    // 4.1 Extract sibling SKU variants from Ozon aspects state. This keeps the
    // backend-only SKU collection path aligned with the browser extension flow.
    try {
      var variantMap = {};
      function normalizeImage(url) {
        return String(url || '').replace(/\\/wc\\d+\\//, '/wc1000/');
      }
      function variantText(v) {
        if (!v) return '';
        if (v.data && Array.isArray(v.data.textRs)) {
          return v.data.textRs.map(function(t) { return t && t.content ? t.content : ''; }).join('');
        }
        return (v.data && (v.data.searchableText || v.data.title || v.data.text)) || '';
      }
      function addAspects(aspects) {
        if (!Array.isArray(aspects)) return;
        aspects.forEach(function(aspect) {
          var aspectName = aspect.aspectName || aspect.title || aspect.name || '';
          (aspect.variants || []).forEach(function(v) {
            var skuValue = String(v.sku || (v.data && (v.data.sku || v.data.id)) || '').trim();
            if (!skuValue) return;
            var d = v.data || {};
            if (!variantMap[skuValue]) {
              variantMap[skuValue] = {
                sku: skuValue,
                title: d.title || d.name || variantText(v) || '',
                price: d.price || d.priceText || '',
                image: normalizeImage(d.coverImage || d.image || ''),
                coverImage: normalizeImage(d.coverImage || d.image || ''),
                link: v.link ? new URL(v.link, location.origin).href : '',
                availability: v.availability || '',
                active: v.active === true,
                aspectValues: {}
              };
            }
            var text = variantText(v);
            if (aspectName && text) variantMap[skuValue].aspectValues[aspectName] = text;
          });
        });
      }
      document.querySelectorAll('[data-state]').forEach(function(el) {
        try {
          var state = JSON.parse(el.getAttribute('data-state') || '{}');
          if (Array.isArray(state.aspects)) addAspects(state.aspects);
        } catch(e) {}
      });
      r.variants = Object.keys(variantMap).map(function(key) { return variantMap[key]; });
    } catch(e) {
      r.variants = [];
    }

    // 4.2 Preserve the public PDP facts for current-category attribute mapping.
    // The full widget uses semantic dl/dt/dd pairs and is more reliable than
    // pairing arbitrary visible text nodes from the page.
    try {
      var sourceCharacteristics = [];
      var seenCharacteristics = {};
      function addCharacteristic(name, value) {
        var cleanName = String(name || '').replace(/\s+/g, ' ').trim();
        var cleanValue = String(value || '').replace(/\s+/g, ' ').trim();
        if (!cleanName || !cleanValue) return;
        var key = cleanName.toLocaleLowerCase('ru-RU') + '\u0000' + cleanValue.toLocaleLowerCase('ru-RU');
        if (seenCharacteristics[key]) return;
        seenCharacteristics[key] = true;
        sourceCharacteristics.push({ name: cleanName, value: cleanValue });
      }
      document.querySelectorAll('[data-widget="webCharacteristics"] dl').forEach(function(row) {
        var name = row.querySelector('dt');
        var value = row.querySelector('dd');
        if (name && value) addCharacteristic(name.textContent, value.textContent);
      });
      if (!sourceCharacteristics.length) {
        document.querySelectorAll('[data-widget="webShortCharacteristics"] dl').forEach(function(row) {
          var name = row.querySelector('dt');
          var value = row.querySelector('dd');
          if (name && value) addCharacteristic(name.textContent, value.textContent);
        });
      }
      r.sourceCharacteristics = sourceCharacteristics;
    } catch(e) {
      r.sourceCharacteristics = [];
    }

    // 5. The JSON-LD usually exposes only the cover. Always read and prefer the
    // complete gallery; having a cover must not suppress the remaining source
    // images needed by downstream angle/text analysis.
    try {
      var galleryImages = [];
      document.querySelectorAll('[data-widget="webGallery"], [id^="state-webGallery"]').forEach(function(gallery) {
        try {
          var gs = JSON.parse(gallery.getAttribute('data-state') || '{}');
          var slides = gs.images || gs.slides || [];
          slides.forEach(function(s) {
            var image = typeof s === 'string'
              ? s
              : (s && (s.src || s.url || s.image || s.imageUrl || s.coverImage)) || '';
            if (image) galleryImages.push(image);
          });
        } catch(e) {}
      });
      if (galleryImages.length) {
        var seenImages = {};
        r.images = galleryImages.concat(Array.isArray(r.images) ? r.images : []).filter(function(image) {
          var cleanImage = String(image || '').trim();
          if (!cleanImage || seenImages[cleanImage]) return false;
          seenImages[cleanImage] = true;
          return true;
        });
        r.primaryImage = r.images[0] || r.primaryImage || '';
      }
    } catch(e) {}

    return JSON.stringify(r);
  })()`);

  function hasProductData(value) {
    try {
      var parsed = JSON.parse(value || '');
      return Boolean(parsed && (parsed.title || parsed.price || parsed.priceText || parsed.primaryImage));
    } catch(e) {
      return false;
    }
  }

  // Ozon may replace the PDP with a temporary "no connection" page while its
  // same-origin composer endpoint still serves the public product widgets.
  // Read only the fields already collected from the DOM path; never retain
  // response tokens or user/session metadata.
  if (!hasProductData(data)) {
    const composerData = await js(`(async function() {
      var requestedSku = '${sku}';
      try {
        var response = await fetch(
          '/api/composer-api.bx/page/json/v2?url=' + encodeURIComponent('/product/' + requestedSku + '/'),
          { credentials: 'include' }
        );
        if (!response.ok) return '';
        var payload = await response.json();
        var states = {};
        Object.keys(payload.widgetStates || {}).forEach(function(key) {
          var value = payload.widgetStates[key];
          try { states[key] = typeof value === 'string' ? JSON.parse(value) : value; }
          catch(e) {}
        });
        function stateFor(name) {
          var key = Object.keys(states).find(function(candidate) {
            return candidate === name || candidate.indexOf(name + '-') === 0;
          });
          return key ? states[key] : {};
        }
        function richText(value) {
          if (!value) return '';
          if (typeof value === 'string') return value.trim();
          var rows = Array.isArray(value) ? value : (value.textRs || []);
          return rows.map(function(row) {
            return row && (row.content || row.text) ? String(row.content || row.text) : '';
          }).join('').replace(/\s+/g, ' ').trim();
        }
        var heading = stateFor('webProductHeading');
        var gallery = stateFor('webGallery');
        var price = stateFor('webPrice');
        var shortCharacteristics = stateFor('webShortCharacteristics');
        var main = stateFor('webProductMainWidget');
        var images = (Array.isArray(gallery.images) ? gallery.images : []).map(function(image) {
          return typeof image === 'string'
            ? image
            : (image && (image.src || image.url || image.image || image.imageUrl)) || '';
        }).filter(Boolean);
        if (gallery.coverImage && images.indexOf(gallery.coverImage) < 0) images.unshift(gallery.coverImage);
        var sourceCharacteristics = (Array.isArray(shortCharacteristics.characteristics)
          ? shortCharacteristics.characteristics : []).map(function(characteristic) {
          var name = richText(characteristic && characteristic.title);
          var values = Array.isArray(characteristic && characteristic.values)
            ? characteristic.values.map(function(value) {
              return richText(value && (value.text || value.title || value.textRs || value));
            }).filter(Boolean)
            : [];
          return { name: name, value: values.join(', ') };
        }).filter(function(characteristic) {
          return characteristic.name && characteristic.value;
        });
        var meta = {};
        try {
          meta = typeof payload.layoutTrackingInfo === 'string'
            ? JSON.parse(payload.layoutTrackingInfo) : (payload.layoutTrackingInfo || {});
        } catch(e) {}
        var variantMap = {};
        function variantText(value) {
          return richText(value && (value.textRs || (value.data && value.data.textRs)))
            || String(value && value.data && (value.data.searchableText || value.data.title || value.data.text) || '').trim();
        }
        Object.values(states).forEach(function(state) {
          if (!state || !Array.isArray(state.aspects)) return;
          state.aspects.forEach(function(aspect) {
            var aspectName = aspect.aspectName || aspect.title || aspect.name || '';
            (aspect.variants || []).forEach(function(variant) {
              var variantData = variant.data || {};
              var variantSku = String(variant.sku || variantData.sku || variantData.id || '').trim();
              if (!variantSku) return;
              if (!variantMap[variantSku]) {
                var image = variantData.coverImage || variantData.image || '';
                variantMap[variantSku] = {
                  sku: variantSku,
                  title: variantData.title || variantData.name || variantText(variant),
                  price: variantData.price || variantData.priceText || '',
                  image: image,
                  coverImage: image,
                  link: variant.link ? new URL(variant.link, location.origin).href : '',
                  availability: variant.availability || '',
                  active: variant.active === true,
                  aspectValues: {}
                };
              }
              var text = variantText(variant);
              if (aspectName && text) variantMap[variantSku].aspectValues[aspectName] = text;
            });
          });
        });
        var priceText = price.price || price.cardPrice || price.originalPrice || '';
        var productUrl = main.url
          ? new URL(main.url, location.origin).href
          : 'https://www.ozon.ru/product/' + requestedSku + '/';
        return JSON.stringify({
          sku: String(main.sku || gallery.sku || requestedSku),
          title: heading.title || '',
          url: productUrl,
          price: priceText,
          priceText: priceText,
          priceCurrency: /(?:¥|CNY)/i.test(priceText) ? 'CNY' : /(?:₽|RUB|руб)/i.test(priceText) ? 'RUB' : '',
          primaryImage: gallery.coverImage || images[0] || '',
          images: images,
          variants: Object.keys(variantMap).map(function(key) { return variantMap[key]; }),
          sourceCharacteristics: sourceCharacteristics,
          categories: String(meta.hierarchy || '').split('/').map(function(value) { return value.trim(); }).filter(Boolean)
        });
      } catch(e) {
        return '';
      }
    })()`);
    if (hasProductData(composerData)) data = composerData;
  }

  if (hasProductData(data)) {
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
