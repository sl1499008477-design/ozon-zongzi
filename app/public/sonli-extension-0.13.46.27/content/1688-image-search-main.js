/**
 * MAIN-world bridge for 1688 image search.
 *
 * The isolated content script cannot call page-owned 1688 helpers directly.
 * This bridge only asks the page's existing mtop/searchSpace request layer to
 * turn an uploaded image base64 payload into an imageId. It intentionally does
 * not patch window.open or any navigation primitive.
 */
(() => {
  if (window.__JZC_1688_IMAGE_SEARCH_MAIN_BRIDGE__) return;
  window.__JZC_1688_IMAGE_SEARCH_MAIN_BRIDGE__ = true;

  const REQUEST_SOURCE = 'jzc-1688-image-search';
  const RESPONSE_SOURCE = 'jzc-1688-image-search-main';
  const REQUEST_TYPE = 'JZC_1688_UPLOAD_IMAGE_ID';
  const RESPONSE_TYPE = 'JZC_1688_UPLOAD_IMAGE_ID_RESULT';

  const getRequestCandidates = () => {
    const candidates = [];
    const mtop = (((window || {}).lib || {}).mtop || {});
    const searchSpace = ((window || {}).searchSpace || {});
    if (mtop.config) {
      mtop.config.prefix = 'h5api';
      mtop.config.mainDomain = '1688.com';
      mtop.config.subDomain = location.href.includes('__mtop_subdomain__=wapa') ? 'wapa' : 'm';
    }

    if (typeof mtop.request === 'function') {
      candidates.push({ name: 'lib.mtop.request', owner: mtop, request: mtop.request });
    }
    if (typeof searchSpace.request === 'function' && searchSpace.request !== mtop.request) {
      candidates.push({ name: 'searchSpace.request', owner: searchSpace, request: searchSpace.request });
    }

    return candidates;
  };
  const toBase64Payload = (value) => String(value || '').replace(/^data:.*;base64,/, '');

  const uploadBase64ToImageId = async (dataUrl) => {
    const imageBase64 = toBase64Payload(dataUrl);
    if (!imageBase64) throw new Error('missing image base64');

    const candidates = getRequestCandidates();
    if (!candidates.length) throw new Error('1688 mtop request is unavailable');

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const response = await candidate.request.call(candidate.owner || window, {
          api: 'mtop.relationrecommend.WirelessRecommend.recommend',
          ignoreLogin: true,
          prefix: 'h5api',
          data: {
            appId: 32517,
            params: JSON.stringify({
              searchScene: 'imageEx',
              interfaceName: 'imageBase64ToImageId',
              'serviceParam.extendParam[imageBase64]': imageBase64,
              subChannel: 'pc_image_search_image_id',
            }),
          },
          v: '2.0',
          ecode: 0,
          type: 'POST',
          dataType: 'jsonp',
          jsonpIncPrefix: 'search1688',
          timeout: 20000,
          trackerConfig: { requestCode: '32517_imageBase64ToImageId' },
        });

        const data = response && response.data ? response.data : response;
        const imageId = data && (data.imageId || data && data.data && data.data.imageId);
        if (imageId) return String(imageId);
        lastError = new Error(`${candidate.name} imageId response is empty`);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('1688 imageId response is empty');
  };
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data || {};
    if (data.source !== REQUEST_SOURCE || data.type !== REQUEST_TYPE) return;

    try {
      const imageId = await uploadBase64ToImageId(data.dataUrl);
      window.postMessage({
        source: RESPONSE_SOURCE,
        type: RESPONSE_TYPE,
        requestId: data.requestId,
        ok: true,
        imageId,
      }, '*');
    } catch (error) {
      window.postMessage({
        source: RESPONSE_SOURCE,
        type: RESPONSE_TYPE,
        requestId: data.requestId,
        ok: false,
        error: (error && error.message) || String(error),
      }, '*');
    }
  });
})();
