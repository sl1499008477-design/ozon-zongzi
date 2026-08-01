(function () {
  if (window.JZCnSourceScraper) return;

  const GLOBAL_KEYS = [
    "__JZ_TEST_DETAIL__",
    "__INIT_DATA__",
    "__INITIAL_STATE__",
    "__APOLLO_STATE__",
    "__NEXT_DATA__",
    "__NUXT__",
    "__pinia",
    "detailData",
    "itemInfo",
    "rawData",
    "gbRawData",
    "gbCommonInfo",
    "__PRODUCT_DETAIL__",
  ];

  const PLATFORM_CONFIGS = {
    jd: {
      sourceId: "jd",
      displayName: "京东",
      idKeys: ["productId", "skuId", "sku", "id"],
      titleSelectors: [".sku-name", "[class*=sku-name]", ".itemInfo-wrap h1", "h1"],
      priceSelectors: [".p-price .price", ".price", "[class*=price]"],
      imagePattern: /360buyimg\.com|jdimg\.com/i,
      rejectImagePattern: /(?:placeholder|loading|grey|spaceball|avatar|logo|sprite|calculator)(?:[._/?#-]|$)|(?:[._/?#-])icon(?:[._/?#-]|$)/i,
      imageSelectors: [
        "img[class*=mainPic]",
        "img[class*=spec-img]",
        "#spec-list img",
        ".spec-list img",
        "#preview img",
        ".preview img",
        "#spec-n1 img",
        ".jqzoom img",
        "[class*=preview] img",
        "[class*=main][class*=img] img",
      ],
      sellerSelectors: [
        "a.name[href*='mall.jd.com']",
        ".J-hove-wrap a.name",
        "[class*=shop] a[href]",
        "[class*=Shop] a[href]",
        "[class*=top-name]",
        ".top-name",
        ".top-name-tag",
        "[class*=vender] a[href]",
        "[class*=Vender] a[href]",
        "a[href*='mall.jd.com']",
        "a[href*='shop.jd.com']",
      ],
      rejectTitlePattern: /最小单价计算器|优惠券|购物车|关注店铺|联系客服|搜索本店|搜全站|降价通知|找同款|店铺|大家评|商品详情|售后保障|推荐/i,
      rejectSellerPattern: /关注店铺|联系客服|搜索本店|搜全站|购物车|首页|我的|桌面版|最小单价计算器/i,
      rejectSellerHrefPattern: /login|cart|help|search/i,
      variantRootSelectors: ["#choose-attrs", ".choose-attrs", "[class*=choose-attrs]", "[class*=sku]", "[class*=Sku]", "[class*=specification]", "[class*=color]", "[class*=Color]", "[class*=size]", "[class*=Size]"],
      variantGroupSelectors: [".choose-attr", "[class*=choose-attr]", "[class*=SkuItem]", "[class*=skuItem]", "[class*=skuColor]", "[class*=skuSize]", "[class*=Color]", "[class*=color]", "[class*=Size]", "[class*=size]", "[class*=spec-group]", "[class*=specification-group]"],
      variantLabelSelectors: [".dt", "[class*=label]", "[class*=Label]", "[class*=title]", "[class*=Title]"],
      variantOptionSelectors: [".dd button", ".dd a", "button", "[role=button]", "li", "a", "[class*=skuOption]", "[class*=SkuOption]", "[class*=option]", "[class*=Option]", "[class*=value]", "[class*=Value]", "[class*=specification-item]"],
      idFromUrl(url) {
        return url.match(/item\.jd\.com\/(\d+)\.html/i)?.[1]
          || url.match(/item\.m\.jd\.com\/product\/(\d+)\.html/i)?.[1]
          || null;
      },
      fallbackUrl(id) {
        return `https://item.jd.com/${id}.html`;
      },
    },
    pdd: {
      sourceId: "pdd",
      displayName: "拼多多批发",
      idKeys: ["goodsId", "goods_id", "productId", "sku", "id"],
      titleSelectors: [".goods-name", "h1", "[class*=goods][class*=name]", "[class*=title]"],
      priceSelectors: [".current-price", ".sku-price", "[class*=price]", "[class*=Price]"],
      imagePattern: /pddpic\.com|pinduoduo\.com|t\d+img\.yangkeduo\.com/i,
      sellerSelectors: ["[class*=mall][class*=name]", "[class*=shop][class*=name]", "a[href*='mall']"],
      variantRootSelectors: [".sku-panel", "[class*=sku]", "[class*=Sku]", "[class*=spec]", "[class*=Spec]"],
      variantGroupSelectors: [".spec-group", "[class*=spec-group]", "[class*=SpecGroup]", "[class*=SpecItem]", "[class*=specItem]", "[class*=SkuItem]", "[class*=skuItem]"],
      variantLabelSelectors: [".spec-label", "[class*=label]", "[class*=Label]", "[class*=title]", "[class*=Title]"],
      variantOptionSelectors: [".spec-option", "button", "[role=button]", "li", "a", "[class*=option]", "[class*=Option]", "[class*=value]", "[class*=Value]", "[class*=SpecValue]", "[class*=specValue]"],
      variantListRowSelectors: [".sku-list-row", "[class*=sku-list-row]", "[class*=SkuListRow]"],
      variantRowNameSelectors: [".sku-title", "[class*=sku-title]", "[class*=SkuTitle]"],
      variantRowPriceSelectors: [".sku-price", "[class*=sku-price]", "[class*=SkuPrice]"],
      variantRowLabelSelectors: [".sku-select-row-label", "[class*=sku-select-row-label]", "[class*=SkuSelectRowLabel]"],
      idFromUrl(url) {
        try {
          const parsed = new URL(url);
          const searchId =
            parsed.searchParams.get("goods_id") ||
            parsed.searchParams.get("goodsId") ||
            parsed.searchParams.get("gid") ||
            parsed.searchParams.get("skuId") ||
            parsed.searchParams.get("spuId");
          if (searchId) return searchId;
          const hashQuery = parsed.hash.includes("?") ? parsed.hash.slice(parsed.hash.indexOf("?")) : "";
          if (hashQuery) {
            const params = new URLSearchParams(hashQuery);
            const hashId =
              params.get("goods_id") ||
              params.get("goodsId") ||
              params.get("gid") ||
              params.get("skuId") ||
              params.get("spuId");
            if (hashId) return hashId;
          }
          return parsed.pathname.match(/(\d{8,})/)?.[1] || null;
        } catch {
          return null;
        }
      },
      fallbackUrl(id) {
        return `https://pifa.pinduoduo.com/goods.html?goods_id=${id}`;
      },
    },
    taobao: {
      sourceId: "taobao",
      displayName: "淘宝/天猫",
      idKeys: ["itemId", "item_id", "productId", "sku", "id"],
      titleSelectors: [
        ".tb-main-title",
        ".tb-detail-hd h1",
        "h1",
        "[class*=BasicContent] [class*=Title--]",
        "[class*=ItemHeader] [class*=Title]",
        "[class*=ItemTitle]",
        "[class*=Title--]",
        "[class*=title]",
      ],
      priceSelectors: [".tb-rmb-num", "[class*=Price]", "[class*=price]"],
      imagePattern: /alicdn\.com|taobaocdn\.com|tmall\.com/i,
      rejectImagePattern: /(?:placeholder|loading|grey|spaceball|avatar|logo|sprite|openshop)(?:[._/?#-]|$)|(?:[._/?#-])icon(?:[._/?#-]|$)/i,
      imageSelectors: [
        "img[class*=mainPic]",
        "img[class*=MainPic]",
        "img[class*=thumbnailPic]",
        "[class*=PicGallery] img",
        "[class*=MainPic] img",
        "[class*=mainPic] img",
        "[class*=imageViewer] img",
        "[class*=gallery] img",
        ".tb-booth img",
        "#J_ImgBooth",
      ],
      sellerSelectors: [
        "[class*=ShopHeader] a[href*='taobao.com']",
        "[class*=ShopHeader] a[href*='tmall.com']",
        "a[class*=detailWrap][href*='shop']",
        "[class*=shop][class*=name]",
        "a[href*='shop'][href*='taobao.com']",
        "a[href*='shop'][href*='tmall.com']",
      ],
      rejectTitlePattern: /用户评价|累计评价|宝贝详情|图文详情|参数信息|本店推荐|看了又看|免费开店|淘宝开店|天猫开店|开直播店|联系客服|购物车|分享商品|问大家|店铺优惠后|优惠前|按图片搜索|品牌|型号|售后服务|品名|保修期/i,
      rejectSellerPattern: /免费开店|淘宝开店|天猫开店|开直播店|登录|注册|购物车|收藏|帮助|联系客服|进店|退出|意见反馈|反馈|我的淘宝|淘宝网首页|账号管理|阿里旺旺/i,
      rejectSellerHrefPattern: /openshop|login|cart|favorite|help|feedback|logout|tblive|zhaoshang|i\.taobao\.com|member|pages\.tmall\.com/i,
      variantRootSelectors: ["[class*=SkuContent]", "[class*=sku-content]", "[class*=skuContent]", "[class*=sku]", "[class*=Sku]", ".tb-sku", "#J_isku"],
      variantGroupSelectors: [".SkuItem--group", "[class*=SkuItem]", "[class*=skuItem]", "[class*=SkuProp]", "[class*=skuProp]", "[class*=SaleProp]", ".tb-prop"],
      variantLabelSelectors: ["[class*=label]", "[class*=Label]", "[class*=title]", "[class*=Title]", ".tb-property-type"],
      variantOptionSelectors: ["button", "[role=button]", "li", "a", "[class*=Value]", "[class*=value]", "[class*=Option]", "[class*=option]"],
      idFromUrl(url) {
        try {
          return new URL(url).searchParams.get("id");
        } catch {
          return null;
        }
      },
      fallbackUrl(id, platform) {
        const host = platform === "tmall" ? "https://detail.tmall.com/item.htm" : "https://item.taobao.com/item.htm";
        return `${host}?id=${id}`;
      },
    },
    amazon: {
      sourceId: "amazon",
      displayName: "Amazon",
      idKeys: ["asin", "productId", "sku", "id"],
      titleSelectors: ["#productTitle", "#title", "h1"],
      priceSelectors: [".a-price .a-offscreen", "#priceblock_ourprice", "#priceblock_dealprice", "[class*=price]"],
      imagePattern: /media-amazon\.com|ssl-images-amazon\.com/i,
      rejectImagePattern: /(?:sprite|transparent|grey|placeholder|loading|avatar|logo)(?:[._/?#-]|$)|(?:[._/?#-])icon(?:[._/?#-]|$)/i,
      imageSelectors: ["#landingImage", "#imgTagWrapperId img", "#imageBlock img", "[class*=imageBlock] img"],
      sellerSelectors: ["#sellerProfileTriggerId", "#visitStoreDesktopUrl", "#bylineInfo", "a[href*='/sp?seller=']", "a[href*='seller=']", "a[href*='/stores/']"],
      rejectTitlePattern: /customer reviews|ratings|answered questions|sponsored|similar item|frequently bought|add to cart|buy now|color|size|style/i,
      rejectSellerPattern: /storefront|customer service|returns/i,
      rejectSellerHrefPattern: /signin|gp\/cart|help|customer|aax-|field-brandtextbin|field-keywords|search-alias|\/(?:-|zh\/)?s(?:\/|\?|$)/i,
      variantRootSelectors: ["#twister_feature_div", "#twister", "[id^=variation_]", "select[id*=native_dropdown]"],
      variantGroupSelectors: ["[id^=variation_]", "select[id*=native_dropdown]"],
      variantLabelSelectors: ["label", ".a-form-label", "[class*=label]", "[class*=Label]"],
      variantOptionSelectors: ["li", "button", "option", "[role=button]"],
      idFromUrl(url) {
        return url.match(/\/dp\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1]
          || url.match(/\/gp\/product\/([A-Z0-9]{10})(?:[/?#]|$)/i)?.[1]
          || null;
      },
      fallbackUrl(id) {
        return `https://www.amazon.com/dp/${id}`;
      },
    },
    wb: {
      sourceId: "wb",
      displayName: "Wildberries",
      idKeys: ["nmId", "productId", "sku", "id"],
      titleSelectors: [".product-page__title", "[class*=product][class*=Title]", "[class*=product][class*=title]", "h1", "[class*=Title]", "[class*=title]"],
      priceSelectors: [".price-block__final-price", "[class*=PriceWallet]", "[class*=PriceNow]", "[class*=final-price]", "[class*=price]", "[class*=Price]"],
      imagePattern: /wbbasket\.ru|wbcontent\.net|wildberries\.ru/i,
      rejectImagePattern: /(?:sprite|placeholder|loading|avatar|logo|wb-og-win|header\/logoWb|\/site\/i\/)(?:[._/?#-]|$)|(?:[._/?#-])icon(?:[._/?#-]|$)/i,
      imageSelectors: [".slide__content", ".swiper-slide img", "[class*=gallery] img", "[class*=photo] img"],
      sellerSelectors: [".seller-info__name", "[class*=seller][class*=name]", "a[href*='/seller/']"],
      rejectTitlePattern: /reviews|questions|seller|similar|recommend|size|color|brand|Интернет.?магазин\s+Wildberries|широкий\s+ассортимент\s+товаров|скидки\s+каждый\s+день/i,
      rejectSellerPattern: /seller rating|reviews|questions|about seller/i,
      rejectSellerHrefPattern: /login|cart|basket|help/i,
      variantRootSelectors: [".colors", ".sizes-list", "[class*=color]", "[class*=size]", "[class*=option]"],
      variantGroupSelectors: [".colors", ".sizes-list", "[class*=color]", "[class*=size]", "[class*=option]"],
      variantLabelSelectors: ["[class*=label]", "[class*=title]", "label"],
      variantOptionSelectors: ["button", "a", "span", "li", "[role=button]"],
      idFromUrl(url) {
        return url.match(/\/catalog\/(\d+)\/detail\.aspx/i)?.[1] || null;
      },
      fallbackUrl(id) {
        return `https://www.wildberries.ru/catalog/${id}/detail.aspx`;
      },
    },
    temu: {
      sourceId: "temu",
      displayName: "Temu",
      idKeys: ["goodsId", "goods_id", "productId", "sku", "id"],
      titleSelectors: [".goods-title", "[class*=goods][class*=title]", "h1", "[class*=title]"],
      priceSelectors: [
        ".price-current",
        ".current-offer-amount",
        "[class*=current][class*=amount]",
        "[class*=offer][class*=amount]",
        "[class*=sale][class*=amount]",
        "[class*=price]",
        "[class*=Price]",
      ],
      imagePattern: /kwcdn\.com|temu\.com/i,
      rejectImagePattern: /(?:sprite|placeholder|loading|avatar|logo|openingemail|flags|frontpage|material-put|upload_commimg|commimg|aftersales|\/pho\/)(?:[._/?#/-]|$)|(?:[._/?#-])icon(?:[._/?#-]|$)/i,
      imageSelectors: [".goods-img", "[class*=goods] img", "[class*=gallery] img", "[class*=main] img"],
      sellerSelectors: [".shop-name", "[class*=shop][class*=name]", "a[href*='mall']"],
      rejectTitlePattern: /reviews|ratings|sold|recommended|similar|cart|share|color|size/i,
      rejectSellerPattern: /cart|help|login|customer service/i,
      rejectSellerHrefPattern: /login|cart|help/i,
      variantRootSelectors: [".sku-panel", "[class*=sku]", "[class*=Sku]", "[class*=option]", "[class*=Option]"],
      variantGroupSelectors: [".sku-row", "[class*=sku-row]", "[class*=SkuItem]", "[class*=option]", "[class*=Option]"],
      variantLabelSelectors: [".sku-label", "[class*=label]", "[class*=Label]", "[class*=title]", "[class*=Title]"],
      variantOptionSelectors: [".sku-chip", "button", "[role=button]", "li", "a", "[class*=chip]", "[class*=Chip]", "[class*=value]", "[class*=Value]"],
      idFromUrl(url) {
        try {
          const parsed = new URL(url);
          return parsed.searchParams.get("goods_id")
            || parsed.searchParams.get("goodsId")
            || parsed.pathname.match(/(\d{8,})/)?.[1]
            || null;
        } catch {
          return null;
        }
      },
      fallbackUrl(id) {
        return `https://www.temu.com/goods.html?goods_id=${id}`;
      },
    },
    mercadolibre: {
      sourceId: "mercadolibre",
      displayName: "Mercado Libre",
      idKeys: ["mlItemId", "itemId", "productId", "sku", "id"],
      titleSelectors: [".ui-pdp-title", "[class*=ui-pdp][class*=title]", "h1", "[class*=title]"],
      priceSelectors: [".andes-money-amount__fraction", "[class*=price]", "[class*=Price]"],
      imagePattern: /mlstatic\.com|mercadolibre\./i,
      rejectImagePattern: /(?:sprite|placeholder|loading|avatar|logo|icon)(?:[._/?#-]|$)/i,
      imageSelectors: [".ui-pdp-gallery img", "[class*=gallery] img", "[class*=carousel] img", "[class*=image] img"],
      sellerSelectors: [".ui-pdp-seller__link", "[class*=seller] a[href]", "a[href*='perfil.mercadolibre']"],
      rejectTitlePattern: /reviews|ratings|seller|similar|recommended|color|size|shipping|questions|opiniones|vendido por|carrito/i,
      rejectSellerPattern: /reviews|questions|shipping|returns/i,
      rejectSellerHrefPattern: /login|cart|help|questions/i,
      variantRootSelectors: [".ui-pdp-variations", "[class*=variation]", "[class*=Variations]", "[class*=picker]", "[class*=Picker]"],
      variantGroupSelectors: [".ui-pdp-variations__picker", "[class*=variation]", "[class*=Variation]", "[class*=picker]", "[class*=Picker]"],
      variantLabelSelectors: [".ui-pdp-variations__label", "[class*=label]", "[class*=Label]", "[class*=title]", "[class*=Title]"],
      variantOptionSelectors: [".ui-pdp-thumbnail-selector", "button", "[role=button]", "li", "a", "[class*=option]", "[class*=Option]", "[class*=value]", "[class*=Value]"],
      idFromUrl(url) {
        try {
          const parsed = new URL(url);
          return parsed.pathname.match(/\/([A-Z]{3}-\d+)(?:[-/]|$)/i)?.[1]
            || parsed.pathname.match(/\/p\/([A-Z]{3}\d+)/i)?.[1]
            || parsed.searchParams.get("item_id")
            || parsed.searchParams.get("id")
            || null;
        } catch {
          return null;
        }
      },
      fallbackUrl(id) {
        return `https://www.mercadolibre.com/p/${id}`;
      },
    },
    yandex: {
      sourceId: "yandex",
      displayName: "Yandex Market",
      idKeys: ["yandexSku", "productId", "modelId", "sku", "id"],
      titleSelectors: ["[data-auto='product-title']", "[data-zone-name='title'] h1", "h1", "[class*=title]", "[class*=Title]"],
      priceSelectors: ["[data-auto='snippet-price-current']", "[data-auto='price']", "[class*=price]", "[class*=Price]"],
      imagePattern: /avatars\.mds\.yandex\.net|yandex\.(?:ru|net|com)/i,
      rejectImagePattern: /(?:sprite|placeholder|loading|avatar|logo|icon)(?:[._/?#-]|$)/i,
      imageSelectors: ["[data-auto='media-viewer'] img", "[class*=gallery] img", "[class*=Gallery] img", "[class*=image] img"],
      sellerSelectors: [
        ".ds-sins-identity__title",
        "[class*=sins-identity__title]",
        "a[href*='merchant-filter='] [class*=title]",
        "a[href*='generalContext=t%3Dmerchant'] [class*=title]",
        "[data-zone-name='shop-name'] a",
        "[data-auto='shop-name']",
        "a[href*='/business--']",
        "a[href*='/shop--']",
      ],
      rejectTitlePattern: /reviews|ratings|seller|similar|recommended|cart|delivery|questions|color|size|otzyv|vopros/i,
      rejectSellerPattern: /rating|reviews|questions|delivery|returns|support/i,
      rejectSellerHrefPattern: /login|cart|basket|help|support/i,
      variantRootSelectors: [".ProductOptions", "[class*=ProductOption]", "[class*=product-option]", "[class*=sku]", "[class*=Sku]", "[class*=option]", "[class*=Option]"],
      variantGroupSelectors: [".ProductOption", "[class*=ProductOption]", "[class*=product-option]", "[class*=option-group]", "[class*=OptionGroup]"],
      variantLabelSelectors: [".ProductOption__title", "[class*=title]", "[class*=Title]", "[class*=label]", "[class*=Label]"],
      variantOptionSelectors: [".ProductOption__value", "button", "[role=button]", "li", "a", "[class*=value]", "[class*=Value]", "[class*=option]", "[class*=Option]"],
      idFromUrl(url) {
        try {
          const parsed = new URL(url);
          return parsed.searchParams.get("sku")
            || parsed.searchParams.get("productId")
            || parsed.searchParams.get("modelid")
            || parsed.searchParams.get("id")
            || parsed.pathname.match(/\/(?:product--[^/]+|card\/[^/]+)\/(\d+)/i)?.[1]
            || null;
        } catch {
          return null;
        }
      },
      fallbackUrl(id) {
        return `https://market.yandex.ru/product/${id}`;
      },
    },
    shein: {
      sourceId: "shein",
      displayName: "SHEIN",
      idKeys: ["goodsSn", "goods_sn", "goodsId", "goods_id", "productId", "sku", "id"],
      titleSelectors: [".product-intro__head-name", ".goods-name", "[class*=goods][class*=name]", "[class*=product][class*=name]", "h1", "[class*=title]", "[class*=Title]"],
      priceSelectors: [".sale-price", ".from", "[class*=price]", "[class*=Price]"],
      imagePattern: /shein\.com|sheincdn\.com|ltwebstatic\.com/i,
      rejectImagePattern: /(?:sprite|placeholder|loading|avatar|logo|icon)(?:[._/?#-]|$)/i,
      imageSelectors: [".product-intro__thumbs img", "[class*=thumb] img", "[class*=gallery] img", "[class*=product-intro] img"],
      sellerSelectors: [".store-title", "[class*=store][class*=title]", "[class*=shop][class*=name]", "a[href*='/store/']"],
      rejectTitlePattern: /reviews|ratings|shipping|returns|recommended|similar|cart|wishlist|domestic\s+shipping|free\s+shipping|shopping\s+security|destination|online\s+shop|fashion\s+online|オンラインショップ/i,
      rejectSellerPattern: /shipping|returns|customer service|wishlist|cart/i,
      rejectSellerHrefPattern: /login|cart|wishlist|help/i,
      variantRootSelectors: [".product-intro__size-choose", "[class*=size-choose]", "[class*=sku]", "[class*=Sku]", "[class*=color]", "[class*=Color]", "[class*=size]", "[class*=Size]"],
      variantGroupSelectors: [".product-intro__color", ".product-intro__size", "[class*=color]", "[class*=Color]", "[class*=size]", "[class*=Size]", "[class*=SkuItem]", "[class*=skuItem]"],
      variantLabelSelectors: [".product-intro__size-title", "[class*=title]", "[class*=Title]", "[class*=label]", "[class*=Label]"],
      variantOptionSelectors: [".color-block", "button", "[role=button]", "li", "a", "[class*=option]", "[class*=Option]", "[class*=value]", "[class*=Value]", "[class*=chip]", "[class*=Chip]"],
      idFromUrl(url) {
        try {
          const parsed = new URL(url);
          return parsed.searchParams.get("goods_id")
            || parsed.searchParams.get("goods_sn")
            || parsed.pathname.match(/-p-(\d+)(?:\.html|[/?#]|$)/i)?.[1]
            || parsed.pathname.match(/-p-([A-Za-z0-9]+)(?:\.html|[/?#]|$)/i)?.[1]
            || null;
        } catch {
          return null;
        }
      },
      fallbackUrl(id) {
        return `https://www.shein.com/p-${id}.html`;
      },
    },
  };

  function cleanText(value) {
    if (typeof value !== "string" && typeof value !== "number") return null;
    const out = String(value).replace(/\s+/g, " ").trim();
    return out || null;
  }

  function isRejectedProductTitle(title, config) {
    if (!title) return true;
    if (title.length < 4) return true;
    if (title.length < 8 && !/[A-Za-z0-9]{2,}/.test(title)) return true;
    if (/\s\/\s/.test(title) && /(?:^|\s)(?:Home|Category|Women|Men|Kids|ホーム|カテゴリ)(?:\s|\/)/i.test(title)) return true;
    if ((title.match(/\//g) || []).length >= 2 && /^(?:Home|Category|Women|Men|Kids|ホーム|カテゴリ)\b/i.test(title)) return true;
    if (config?.rejectTitlePattern?.test(title)) return true;
    if (/^(首页|分类|店铺|客服|评价|详情|参数|推荐|更多|登录|注册|规格|颜色|香味|净含量|蓝牙版本)$/i.test(title)) return true;
    if (/^[\d\s.+·-]+$/.test(title)) return true;
    return false;
  }

  function elementContext(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      parts.push(String(node.tagName || ""));
      parts.push(String(node.id || ""));
      parts.push(String(node.className || ""));
    }
    return parts.join(" ");
  }

  function isVariantLikeContext(context) {
    return /sku|spec|prop|sale|price|coupon|tab|param|thumb|shop|button|option|value|size|color|choose|attr|review|rating|shipping|delivery|quality[-_\s]?tag|goods[-_\s]?tag|discount[-_\s]?label/i.test(context || "");
  }

  function titleCandidateScore(candidate, config) {
    const title = cleanProductTitle(candidate?.title);
    if (isRejectedProductTitle(title, config)) return -Infinity;
    const strongProductTitleContext =
      candidate.source === "selector" &&
      /(?:product[-_\s]?(?:title|name)|product[-_\s]?intro__head[-_\s]?name|productTitle|goods[-_\s]?(?:title|name)|item[-_\s]?title|titleText|title__text)/i.test(candidate.context || "") &&
      !isVariantLikeContext(candidate.context || "");
    let score = Math.min(title.length, 120);
    if (candidate.source === "document") score += 120;
    if (candidate.source === "structured") score += 45;
    if (candidate.source === "selector") score += 25;
    if (strongProductTitleContext) score += 60;
    if (/^H1$/i.test(candidate.tag || "")) score += 80;
    if (/title/i.test(candidate.context || "")) score += 12;
    if (!strongProductTitleContext && isVariantLikeContext(candidate.context)) score -= 120;
    if (/用户评价|参数信息|图文详情|本店推荐|看了又看|问大家/i.test(title)) score -= 200;
    return score;
  }

  function isStrongProductTitleCandidate(candidate) {
    return candidate?.source === "selector" &&
      /(?:product[-_\s]?(?:title|name)|product[-_\s]?intro__head[-_\s]?name|productTitle|goods[-_\s]?(?:title|name)|item[-_\s]?title|titleText|title__text)/i.test(candidate.context || "") &&
      !isVariantLikeContext(candidate.context || "");
  }

  function titleCandidatesFromSelectors(config) {
    const candidates = [];
    for (const selector of config?.titleSelectors || []) {
      document.querySelectorAll(selector).forEach((el) => {
        const title = cleanProductTitle(el?.textContent);
        if (!title) return;
        candidates.push({
          title,
          source: "selector",
          selector,
          tag: el?.tagName,
          context: elementContext(el),
        });
      });
    }
    return candidates;
  }

  function titleFromSheinUrl() {
    const match = location.pathname.match(/\/([^/]+)-p-[A-Za-z0-9]+(?:\.html|[/?#]|$)/i);
    if (!match?.[1]) return null;
    return cleanProductTitle(decodeURIComponent(match[1]).replace(/-/g, " "));
  }

  function chooseProductTitle(structured, config) {
    const candidates = [
      ...titleCandidatesFromSelectors(config),
      { title: titleFromDocument(), source: "document", context: "document title" },
      { title: structured?.title, source: "structured", context: "structured title" },
      { title: config?.sourceId === "shein" ? titleFromSheinUrl() : null, source: "url", context: "url slug" },
    ].filter((item) => cleanProductTitle(item.title));

    const uniqueCandidates = [];
    const seen = new Set();
    for (const candidate of candidates) {
      const title = cleanProductTitle(candidate.title);
      if (!title || seen.has(title)) continue;
      seen.add(title);
      uniqueCandidates.push({ ...candidate, title, score: titleCandidateScore(candidate, config) });
    }

    {
      const selectorTitle = uniqueCandidates.find(isStrongProductTitleCandidate);
      const h1Title = uniqueCandidates.find((item) => /^H1$/i.test(item.tag || "") && item.source === "selector");
      const documentTitle = uniqueCandidates.find((item) => item.source === "document");
      if (selectorTitle && (!documentTitle || documentTitle.title.includes(selectorTitle.title))) {
        return selectorTitle.title;
      }
      if (h1Title && h1Title.title.length >= 12 && documentTitle?.title.includes(h1Title.title)) {
        return h1Title.title;
      }
    }

    uniqueCandidates.sort((a, b) => b.score - a.score);
    return uniqueCandidates.find((item) => item.score > -Infinity)?.title || null;
  }

  function stripYandexShopTitleSuffix(value) {
    const title = cleanText(value);
    if (!title) return null;
    return title
      .replace(/\s*[-–]\s*купить\s+в\s+интернет-магазине\s+.+?\s+на\s+Яндекс\s+Маркете(?:,.*)?$/i, "")
      .trim() || title;
  }

  function stripLeadingProductBadges(value) {
    let title = cleanText(value);
    if (!title) return null;
    for (let i = 0; i < 5; i += 1) {
      const next = title
        .replace(/^(?:新品|トレンド|国内発送|送料無料|高リピート率)\s*/i, "")
        .replace(/^販売数急増\s*\d+%\s*/i, "")
        .trim();
      if (next === title) break;
      title = next;
    }
    return title || cleanText(value);
  }

  function titleFromDocument() {
    const title = cleanText(document.title);
    if (!title) return null;
    return stripLeadingProductBadges(stripYandexShopTitleSuffix(title))
      .replace(/^\s*Amazon(?:\.[a-z.]+)?:\s*/i, "")
      .replace(/^\s*(?:本地仓库|Local\s+warehouse)\s+/i, "")
      .replace(/\s*[-_|]\s*(拼多多批发|拼多多|京东|淘宝网|淘宝|天猫|tmall\.com天猫|1688).*$/i, "")
      .replace(/\s*[-_|]\s*tmall\.com天猫\s*$/i, "")
      .replace(/\s*[–-]\s*купить на Яндекс(?:\s+Маркете)?(?:,.*)?$/i, "")
      .replace(/\s*\|\s*(?:Env[ií]o|Frete)\s+gr[aá]tis.*$/i, "")
      .replace(/\s*,?\s*undefined\s*$/i, "")
      .replace(/\s*(?::|\||-|\/)\s*(Amazon(?:\.[a-z.]+)?|Wildberries|Temu(?:\s+Temu)?(?:\s+Japan)?|Mercado\s*Libre|MercadoLibre|Yandex\s*Market|SHEIN(?:\s+JAPAN)?)\s*$/i, "")
      .trim() || title;
  }

  function cleanProductTitle(value) {
    const title = cleanText(value);
    if (!title) return null;
    return stripLeadingProductBadges(stripYandexShopTitleSuffix(title))
      .replace(/^\s*Amazon(?:\.[a-z.]+)?:\s*/i, "")
      .replace(/^\s*(?:本地仓库|Local\s+warehouse)\s+/i, "")
      .replace(/\s*分享商品\s*$/i, "")
      .replace(/\s*[-_|]\s*(拼多多批发|拼多多|京东|淘宝网|淘宝|天猫|tmall\.com天猫|1688).*$/i, "")
      .replace(/\s*[–-]\s*купить на Яндекс(?:\s+Маркете)?(?:,.*)?$/i, "")
      .replace(/\s*\|\s*(?:Env[ií]o|Frete)\s+gr[aá]tis.*$/i, "")
      .replace(/\s*,?\s*undefined\s*$/i, "")
      .replace(/\s*(?::|\||-|\/)\s*(Amazon(?:\.[a-z.]+)?|Wildberries|Temu(?:\s+Temu)?(?:\s+Japan)?|Mercado\s*Libre|MercadoLibre|Yandex\s*Market|SHEIN(?:\s+JAPAN)?)\s*$/i, "")
      .trim() || title;
  }

  function absoluteUrl(src) {
    if (!src || typeof src !== "string") return null;
    let out = src.trim().replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
    if (!out || out.startsWith("data:")) return null;
    if (out.startsWith("//")) out = `${location.protocol}${out}`;
    if (out.startsWith("/")) out = `${location.origin}${out}`;
    return out.split("#")[0];
  }

  function normalizeImage(src, config) {
    let out = absoluteUrl(src);
    if (!out || /\.svg(?:\?|$)/i.test(out)) return null;
    if (config?.rejectImagePattern?.test(out)) return null;
    if (config?.imagePattern && !config.imagePattern.test(out)) return null;
    out = out.split("?")[0]
      .replace(/!(?:cc_|q\d+).*$/i, "")
      .replace(/\/([^/.]+)\._[^/.]+\.(jpg|jpeg|png|webp)$/i, "/$1.$2")
      .replace(/(\.[A-Z0-9_-]+)\._[^/.]+\.(jpg|jpeg|png|webp)$/i, "$1.$2")
      .replace(/(_!![^/]+?\.(?:jpg|jpeg|png|webp))_[^/]+$/i, "$1")
      .replace(/_(\d+)x(\d+)q?\d*\.(jpg|jpeg|png|webp)(?:_?\.webp)?$/i, ".$3")
      .replace(/\.(jpg|jpeg|png|webp)_\.webp$/i, ".$1")
      .replace(/\.(jpg|jpeg|png|webp)\.webp$/i, ".$1");
    if (config?.sourceId === "wb") {
      out = out.replace(/\/images\/(?:tm|c\d+x\d+|small|mini)\//i, "/images/big/");
    }
    return out;
  }

  function pushRawImageValue(raw, value) {
    if (typeof value === "string") raw.push(value);
    if (Array.isArray(value)) raw.push(...value);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      raw.push(pick(value, ["url", "image", "imageUrl", "imgUrl", "picUrl", "src"]));
    }
  }

  function unique(values, limit = 30) {
    const out = [];
    const seen = new Set();
    for (const value of values) {
      const s = cleanText(value);
      if (!s || seen.has(s)) continue;
      seen.add(s);
      out.push(s);
      if (out.length >= limit) break;
    }
    return out;
  }

  function moneyFromText(value) {
    const matches = String(value || "").replace(/\u00a0/g, " ").match(/\d[\d\s.,]*/g) || [];
    for (const raw of matches) {
      const token = raw.replace(/\s+/g, "");
      const lastComma = token.lastIndexOf(",");
      const lastDot = token.lastIndexOf(".");
      const sep = lastComma > lastDot ? "," : lastDot > -1 ? "." : "";
      const tail = sep ? token.slice(token.lastIndexOf(sep) + 1) : "";
      const decimalSep = tail.length > 0 && tail.length <= 2 ? sep : "";
      const normalized = decimalSep
        ? token
            .replace(new RegExp(`\\${decimalSep === "," ? "." : ","}`, "g"), "")
            .replace(decimalSep, ".")
        : token.replace(/[,.]/g, "");
      const n = Number(normalized);
      if (Number.isFinite(n) && n > 0) return n.toString();
    }
    return null;
  }

  function moneyFromSelectors(selectors) {
    for (const selector of selectors || []) {
      for (const el of document.querySelectorAll(selector)) {
        const value = moneyFromText(el?.textContent);
        if (value) return value;
      }
    }
    return null;
  }

  function normalizeCurrencyCode(value) {
    const text = cleanText(value)?.toUpperCase();
    if (!text) return null;
    if (text === "RMB" || text === "CNH" || text === "CNY") return "CNY";
    if (["RUB", "JPY", "USD", "EUR", "GBP", "BRL", "MXN"].includes(text)) return text;
    return null;
  }

  function currencyFromText(value, config) {
    const text = String(value || "");
    if (!text) return null;
    if (/[₽]|(?:^|[\s\d])(?:RUB|руб\.?|рублей|rubles?)(?:$|[\s\d.,])/i.test(text)) return "RUB";
    if (/円|(?:^|[\s\d])JPY(?:$|[\s\d.,])/i.test(text)) return "JPY";
    if (/R\$/i.test(text)) return "BRL";
    if (/MX\$/i.test(text)) return "MXN";
    if (/€|(?:^|[\s\d])EUR(?:$|[\s\d.,])/i.test(text)) return "EUR";
    if (/£|(?:^|[\s\d])GBP(?:$|[\s\d.,])/i.test(text)) return "GBP";
    if (/(?:US\$)|(?:^|[\s\d])USD(?:$|[\s\d.,])/i.test(text)) return "USD";
    if (/[$]/.test(text) && ["amazon", "shein", "temu"].includes(config?.sourceId)) return "USD";
    if (/[¥￥]/.test(text)) {
      if (
        (config?.sourceId === "temu" && /(?:^|\/)jp(?:[-_/]|$)|temu\.jp|jp\.temu/i.test(location.href)) ||
        (config?.sourceId === "shein" && /(?:^|\/)jp(?:[-_/]|$)|jp\.shein/i.test(location.href))
      ) return "JPY";
      return "CNY";
    }
    return null;
  }

  function moneyInfoFromText(value, config, explicitCurrency) {
    const price = moneyFromText(value);
    if (!price) return null;
    return {
      price,
      currency: normalizeCurrencyCode(explicitCurrency) || currencyFromText(value, config),
    };
  }

  function moneyInfoFromSelectors(selectors, config) {
    for (const selector of selectors || []) {
      for (const el of document.querySelectorAll(selector)) {
        const info = moneyInfoFromText(el?.textContent, config);
        if (info?.price) return info;
      }
    }
    return null;
  }

  function moneyInfoFromVisibleCurrencyNodes(config) {
    if (!["temu", "shein"].includes(config?.sourceId)) return null;
    const candidates = [];
    document.querySelectorAll("div, span, p, strong, em, b").forEach((el, index) => {
      const text = cleanText(el?.textContent);
      if (!text || text.length > 80) return;
      const info = moneyInfoFromText(text, config);
      if (!info?.price || !info.currency) return;
      const cls = `${el.className || ""} ${el.id || ""}`;
      let score = 1000 - Math.min(index, 400);
      if (/price|amount|offer|sale|current|final|from/i.test(cls)) score += 500;
      if (/original|market|list|old|strike|del/i.test(cls)) score -= 600;
      if (config?.sourceId === "temu" && info.currency === "JPY") score += 200;
      if (config?.sourceId === "shein" && info.currency === "JPY") score += 200;
      candidates.push({ info, score });
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.info || null;
  }

  function allowBodyPriceFallback(config) {
    return ["jd", "pdd", "taobao"].includes(config?.sourceId);
  }

  function pick(obj, keys) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
      if (obj[key] != null) return obj[key];
    }
    return undefined;
  }

  function readJsonLd() {
    const out = [];
    document.querySelectorAll('script[type="application/ld+json"]').forEach((script) => {
      try {
        const parsed = JSON.parse(script.textContent || "");
        if (parsed) out.push(parsed);
      } catch {}
    });
    return out;
  }

  function structuredRoots() {
    const roots = [];
    for (const key of GLOBAL_KEYS) {
      try {
        const value = window[key];
        if (value && typeof value === "object") roots.push(value);
      } catch {}
    }
    roots.push(...readJsonLd());
    return roots;
  }

  function walkObjects(root, visit, depth = 0, seen = new Set()) {
    if (!root || typeof root !== "object" || depth > 8 || seen.has(root)) return;
    seen.add(root);
    visit(root);
    const values = Array.isArray(root) ? root.slice(0, 200) : Object.values(root).slice(0, 200);
    for (const value of values) walkObjects(value, visit, depth + 1, seen);
  }

  function findStructuredData(config) {
    const candidate = {};
    for (const root of structuredRoots()) {
      walkObjects(root, (obj) => {
        const id = pick(obj, config.idKeys);
        if (id && !candidate.id) candidate.id = id;
        const title = cleanProductTitle(pick(obj, ["title", "name", "shortTitle", "skuName", "goodsName", "itemName"]));
        if (title && !candidate.title && !isRejectedProductTitle(title, config)) candidate.title = title;
        const price = pick(obj, ["price", "salePrice", "currentPrice", "minPrice"]);
        if (price && !candidate.price) candidate.price = price;
        const priceCurrency = pick(obj, ["priceCurrency", "currency", "currencyCode", "currency_code"]);
        if (priceCurrency && !candidate.priceCurrency) candidate.priceCurrency = priceCurrency;
        const originalPrice = pick(obj, ["originalPrice", "marketPrice", "listPrice"]);
        if (originalPrice && !candidate.originalPrice) candidate.originalPrice = originalPrice;
        const videoUrl = pick(obj, ["videoUrl", "video_url", "mainVideoUrl", "playUrl", "mp4Url"]);
        if (videoUrl && !candidate.videoUrl) candidate.videoUrl = videoUrl;
        const videoCover = pick(obj, ["videoCover", "videoCoverUrl", "poster", "coverUrl"]);
        if (videoCover && !candidate.videoCover) candidate.videoCover = videoCover;
        const seller = pick(obj, ["seller", "shop", "store", "mall"]);
        if (seller && typeof seller === "object" && !candidate.seller) candidate.seller = seller;
        const brand = pick(obj, ["brand", "brandName", "brand_name", "brand_name_en"]);
        const brandName = cleanText(typeof brand === "object" ? pick(brand, ["name", "title"]) : brand);
        if (brandName && !candidate.brandName) candidate.brandName = brandName;
        const images = pick(obj, ["images", "image", "imageList", "mainImages", "pictures", "picList"]);
        if (images && !candidate.images) candidate.images = images;
        const variants = pick(obj, ["variants", "skuList", "skus"]);
        if (Array.isArray(variants) && variants.length && !candidate.variants) candidate.variants = variants;
      });
    }
    const metaBrand = cleanText(
      document.querySelector('meta[property="product:brand"], meta[name="product:brand"], meta[property="og:brand"], meta[name="brand"]')?.getAttribute("content")
    );
    if (metaBrand && !candidate.brandName) candidate.brandName = metaBrand;
    return candidate;
  }

  function pushImageElement(raw, img) {
    if (!img) return;
    raw.push(img.getAttribute("data-origin"));
    raw.push(img.getAttribute("data-lazy-img"));
    raw.push(img.getAttribute("data-src"));
    raw.push(img.getAttribute("data-srcset")?.split(/\s+/)[0]);
    raw.push(img.currentSrc);
    raw.push(img.getAttribute("src"));
    raw.push(img.getAttribute("srcset")?.split(/\s+/)[0]);
  }

  function pushStyleImages(raw, el) {
    const style = el?.getAttribute?.("style") || "";
    const bgMatches = style.matchAll(/url\(["']?([^"')]+)["']?\)/gi);
    for (const match of bgMatches) raw.push(match[1]);
  }

  function collectImagesBySelectors(raw, selectors) {
    for (const selector of selectors || []) {
      document.querySelectorAll(selector).forEach((el) => {
        if (el.tagName?.toLowerCase() === "img") pushImageElement(raw, el);
        el.querySelectorAll?.("img").forEach((img) => pushImageElement(raw, img));
        pushStyleImages(raw, el);
        el.querySelectorAll?.("[style]").forEach((child) => pushStyleImages(raw, child));
      });
    }
  }

  function normalizeSellerName(value, config) {
    let name = cleanText(value);
    if (!name) return null;
    if (config?.sourceId === "amazon") {
      name = name
        .replace(/^\s*Visit\s+(?:the\s+)?/i, "")
        .replace(/^\s*Brand\s*:\s*/i, "")
        .replace(/\s+Storefront\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    if (config?.sourceId === "shein") {
      name = name
        .replace(/^\s*Marketplace\s+/i, "")
        .replace(/^\s*Ships?\s+from\s+/i, "")
        .replace(/\s+(?:sold\s+by|sells?|Local\s+Seller|Trend)\s*$/i, "")
        .replace(/\s+が販売\s*$/i, "")
        .replace(/\s+から発送\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    return name || null;
  }

  function isTemuSellerMetricText(text) {
    return /^(?:\d[\d,.]*|粉丝|已售|评分|关注|所有商品|全部商品|店铺商品|试穿|试穿尺码|试穿心得|身高|胸围|腰围|臀围|数量|颜色|尺码)$/i.test(cleanText(text));
  }

  function temuSellerFromProfileCard(config) {
    if (config?.sourceId !== "temu") return null;
    const mallLinks = [...document.querySelectorAll("a[href*='mall'], a[href*='mall_id']")];
    for (const link of mallLinks) {
      const href = cleanText(link.href);
      if (!href || config?.rejectSellerHrefPattern?.test(href)) continue;
      let container = link;
      for (let depth = 0; depth < 6 && container?.parentElement; depth += 1) {
        container = container.parentElement;
        const text = cleanText(container?.textContent);
        if (!text || text.length > 800) continue;
        const looksLikeSellerCard =
          /(?:粉丝|Followers?|フォロワー)/i.test(text) &&
          /(?:已售|Sold|販売済み)/i.test(text) &&
          /(?:评分|Rating|評価)/i.test(text);
        if (!looksLikeSellerCard) continue;

        const candidates = [];
        container.querySelectorAll("div, span, strong, b, a").forEach((el, index) => {
          const raw = cleanText(el.textContent);
          const name = normalizeSellerName(raw, config);
          if (!name) return;
          if (name.length < 2 || name.length > 60) return;
          if (config?.rejectSellerPattern?.test(name)) return;
          if (isTemuSellerMetricText(name)) return;
          if (/所有商品|全部商品|店铺商品|关注|粉丝|已售|评分|试穿|身高|胸围|腰围|臀围|由该卖家发货|标运|安全支付|免费退货/i.test(name)) return;
          let score = 1000 - index;
          const className = cleanText(el.getAttribute?.("class"));
          if (/name|title|store|shop|mall|profile/i.test(className)) score += 400;
          if (/^[A-Z0-9][A-Z0-9 _.-]{2,}$/i.test(name)) score += 120;
          if (el.tagName?.toLowerCase() === "a") score -= 150;
          candidates.push({ name, score, index });
        });
        candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index));
        if (candidates[0]?.name) return { name: candidates[0].name, shopUrl: href };
      }
    }
    return null;
  }

  function isSheinSellerNoiseText(text) {
    return /^(?:Marketplace|Local Seller|Shop info|All products|View all|Follow|Free shipping|Free returns|Destination|Shopping security|Safe payment|Privacy protection|Sold recently|Purchased|Reviews?|Size info|Product info|Description)$/i.test(cleanText(text));
  }

  function sheinSellerFromMarketplaceCard(config) {
    if (config?.sourceId !== "shein") return null;
    const dataStoreCards = [...document.querySelectorAll("[data-is-store='true'][data-name], [data-brand-type='store'][data-name]")];
    for (const card of dataStoreCards) {
      const rawName = cleanText(card.getAttribute("data-name"));
      const name = normalizeSellerName(rawName, config);
      if (!name || config?.rejectSellerPattern?.test(name) || isSheinSellerNoiseText(name)) continue;
      const brandCode = cleanText(card.getAttribute("data-brand-code") || card.getAttribute("data-id"));
      const href = cleanText(card.href || card.closest?.("a")?.href);
      const shopUrl = href || (brandCode ? `${location.origin}/store/home?store_code=${encodeURIComponent(brandCode)}` : null);
      if (shopUrl && config?.rejectSellerHrefPattern?.test(shopUrl)) return { name, shopUrl: null };
      return { name, shopUrl };
    }

    const storeLinks = [...document.querySelectorAll("a[href*='/store/'], a[href*='store_code='], a[href*='storeId=']")];
    const anchors = storeLinks.length ? storeLinks : [...document.querySelectorAll("a")].filter((link) => /store|shop|all products|すべての商品/i.test(cleanText(link.href || link.textContent)));
    const fallbackCards = [...document.querySelectorAll("section, aside, div")].filter((el) => {
      const text = cleanText(el.textContent);
      return text && text.length < 1200 && /Shop\s+info/i.test(text) && /(?:All\s+products|View\s+all|Follow|sold|followers?|purchases?)/i.test(text);
    });
    const sheinSellerSeeds = storeLinks.length ? anchors : [...anchors, ...fallbackCards.map((card) => card.querySelector("a, button, strong, b, span") || card)];
    for (const link of sheinSellerSeeds) {
      const href = cleanText(link.href);
      if (href && config?.rejectSellerHrefPattern?.test(href)) continue;
      let container = link;
      for (let depth = 0; depth < 7 && container?.parentElement; depth += 1) {
        container = container.parentElement;
        const text = cleanText(container?.textContent);
        if (!text || text.length > 1200) continue;
        const looksLikeSellerCard =
          /(?:Marketplace|Local\s+Seller|Shop\s+info|ショップ情報|が販売|から発送)/i.test(text) &&
          /(?:All\s+products|View\s+all|すべての商品|store_code|Local\s+Seller|Shop\s+info|ショップ情報)/i.test(`${text} ${href || ""}`);
        if (!looksLikeSellerCard) continue;

        const candidates = [];
        container.querySelectorAll("div, span, strong, b, a, h2, h3").forEach((el, index) => {
          const raw = cleanText(el.textContent);
          const name = normalizeSellerName(raw, config);
          if (!name) return;
          if (name.length < 2 || name.length > 60) return;
          if (config?.rejectSellerPattern?.test(name)) return;
          if (isSheinSellerNoiseText(name)) return;
          if (/All products|View all|Follow|Free shipping|Free returns|Destination|Shopping security|Safe payment|Privacy|recently|purchased|reviews?|Product info|Size info|Shop info|Marketplace$/i.test(name)) return;
          let score = 1000 - index;
          const className = cleanText(el.getAttribute?.("class"));
          if (/seller|store|shop|name|title|marketplace/i.test(className)) score += 420;
          if (/Local\s+Seller|Marketplace|sold\s+by|Ships?\s+from/i.test(raw)) score += 260;
          if (/^[A-Z0-9][A-Z0-9 _.-]{2,}$/i.test(name)) score += 120;
          if (el.tagName?.toLowerCase() === "a") score -= 120;
          candidates.push({ name, score, index });
        });
        candidates.sort((a, b) => (b.score - a.score) || (a.index - b.index));
        if (candidates[0]?.name) return { name: candidates[0].name, shopUrl: href || null };
      }
    }
    return null;
  }

  function imagePriority(src, config, index) {
    let score = 1000 - Math.min(index, 300);
    const id = cleanText(config?.idFromUrl?.(location.href));
    if (config?.sourceId === "wb") {
      if (/\/site\/i\/|wb-og-win|footer\/download/i.test(src)) score -= 2000;
      if (id && src.includes(`/${id}/images/`)) score += 1200;
      if (/\/images\/big\//i.test(src)) score += 180;
      if (/\/images\/c\d+x\d+\//i.test(src)) score += 120;
      if (/\/images\/tm\//i.test(src)) score += 60;
    }
    if (config?.sourceId === "temu") {
      if (/img\.kwcdn\.com\/product\/(?:open|fancy|goods|FancyAlgo)/i.test(src)) score += 1200;
      else if (/img\.kwcdn\.com\/product\//i.test(src)) score += 900;
      else if (/aimg\.kwcdn\.com\/upload_aimg\/commodity/i.test(src)) score += 20;
      if (/upload_aimg|upload_commimg|commimg|openingemail|flags|frontpage|material-put|aftersales|\/pho\//i.test(src)) score -= 1500;
    }
    return score;
  }

  function rankedUniqueImages(raw, config, limit) {
    const ranked = [];
    raw.forEach((src, index) => {
      const normalized = normalizeImage(src, config);
      if (!normalized) return;
      ranked.push({ src: normalized, score: imagePriority(normalized, config, index), index });
    });
    if (config?.sourceId === "wb") {
      const id = cleanText(config?.idFromUrl?.(location.href));
      if (id && ranked.some((item) => item.src.includes(`/${id}/images/`))) {
        for (let i = ranked.length - 1; i >= 0; i -= 1) {
          if (!ranked[i].src.includes(`/${id}/images/`)) ranked.splice(i, 1);
        }
      }
    }
    if (config?.sourceId === "temu" && ranked.some((item) => item.score >= 1800)) {
      for (let i = ranked.length - 1; i >= 0; i -= 1) {
        if (ranked[i].score < 1800) ranked.splice(i, 1);
      }
    }
    ranked.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return unique(ranked.map((item) => item.src), limit);
  }

  function normalizeImageList(value, config) {
    const raw = [];
    collectImagesBySelectors(raw, config?.imageSelectors);
    pushRawImageValue(raw, value);
    document.querySelectorAll("img").forEach((img) => {
      pushImageElement(raw, img);
    });
    document.querySelectorAll("[style]").forEach((el) => {
      pushStyleImages(raw, el);
    });
    raw.push(document.querySelector('meta[property="og:image"]')?.getAttribute("content"));
    return rankedUniqueImages(raw, config, 30);
  }

  function normalizeProvidedImageList(value, config) {
    const raw = [];
    pushRawImageValue(raw, value);
    return rankedUniqueImages(raw, config, 12);
  }

  function sellerFromSelectors(config) {
    const temuProfileSeller = temuSellerFromProfileCard(config);
    if (temuProfileSeller) return temuProfileSeller;
    const sheinMarketplaceSeller = sheinSellerFromMarketplaceCard(config);
    if (sheinMarketplaceSeller) return sheinMarketplaceSeller;
    for (const selector of config?.sellerSelectors || []) {
      for (const el of document.querySelectorAll(selector)) {
        const rawName = cleanText(el?.textContent);
        const name = normalizeSellerName(rawName, config);
        const href = cleanText(el?.href || el?.closest?.("a")?.href);
        if (
          config?.sourceId === "amazon" &&
          /^(?:Brand|品牌|ブランド)\s*[:：]/i.test(rawName || "") &&
          !(href && /\/(?:stores|sp\?seller=)|[?&]seller=/i.test(href))
        ) {
          continue;
        }
        if (name && config?.rejectSellerPattern?.test(name)) continue;
        if (href && config?.rejectSellerHrefPattern?.test(href)) continue;
        if (name || href) return { name, shopUrl: href };
      }
    }
    return null;
  }

  function normalizeSeller(structured, config) {
    const seller = structured?.seller && typeof structured.seller === "object" ? structured.seller : {};
    const selectedSeller = sellerFromSelectors(config);
    const structuredName = normalizeSellerName(pick(seller, ["name", "shopName", "storeName", "title"]), config);
    const structuredShopUrl = cleanText(pick(seller, ["shopUrl", "url", "link"]));
    const validStructuredSeller =
      structuredName &&
      !config?.rejectSellerPattern?.test(structuredName) &&
      !(structuredShopUrl && config?.rejectSellerHrefPattern?.test(structuredShopUrl));
    const name = selectedSeller?.name || (validStructuredSeller ? structuredName : null);
    let shopUrl = cleanText(pick(seller, ["shopUrl", "url", "link"]));
    if (selectedSeller?.shopUrl) shopUrl = selectedSeller.shopUrl;
    if (shopUrl && config?.rejectSellerHrefPattern?.test(shopUrl)) shopUrl = null;
    if (!name && !shopUrl) {
      if (config?.sourceId === "temu") return { name: "Temu", shopUrl: null };
      if (config?.sourceId === "shein") return { name: "SHEIN", shopUrl: location.origin };
    }
    return name || shopUrl ? { name, shopUrl } : null;
  }

  function normalizeVariants(value, config) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 120).map((item, index) => {
      const aspectValues = item?.aspectValues || item?.attrs || item?.properties;
      const images = normalizeProvidedImageList([...(Array.isArray(item?.images) ? item.images : []), item?.image], config);
      return {
        sku: cleanText(pick(item, ["sku", "id", "skuId", "itemId"])) || `variant-${index + 1}`,
        name: cleanText(pick(item, ["name", "skuName", "title"])),
        price: moneyFromText(pick(item, ["price", "salePrice", "currentPrice"])),
        priceCurrency: normalizeCurrencyCode(pick(item, ["priceCurrency", "currency", "currencyCode", "currency_code"])) || currencyFromText(pick(item, ["price", "salePrice", "currentPrice"]), config) || undefined,
        image: images[0] || null,
        images,
        aspectValues: aspectValues && typeof aspectValues === "object" ? aspectValues : undefined,
        stock: Number.isFinite(Number(item?.stock ?? item?.quantity)) ? Number(item.stock ?? item.quantity) : undefined,
      };
    });
  }

  function parseLooseJson(raw) {
    if (!raw || typeof raw !== "string") return null;
    try {
      return JSON.parse(raw.replace(/,\s*([}\]])/g, "$1"));
    } catch {
      return null;
    }
  }

  function balancedJsonValueAt(text, start) {
    const open = text[start];
    const close = open === "{" ? "}" : open === "[" ? "]" : null;
    if (!close) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === open) depth += 1;
      if (ch === close) {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    return null;
  }

  function extractJsonObjectByKey(text, key) {
    if (!text || !key) return null;
    const markers = [`"${key}"`, `'${key}'`, key];
    for (const marker of markers) {
      let searchFrom = 0;
      while (searchFrom < text.length) {
        const markerIndex = text.indexOf(marker, searchFrom);
        if (markerIndex < 0) break;
        const colonIndex = text.indexOf(":", markerIndex + marker.length);
        if (colonIndex < 0) break;
        const valueStart = text.slice(colonIndex + 1).search(/[\[{]/);
        if (valueStart < 0) break;
        const absoluteStart = colonIndex + 1 + valueStart;
        const raw = balancedJsonValueAt(text, absoluteStart);
        const parsed = parseLooseJson(raw);
        if (parsed && typeof parsed === "object") return parsed;
        searchFrom = markerIndex + marker.length;
      }
    }
    return null;
  }

  function amazonVariationLabel(key, labels) {
    const configured = cleanVariantText(labels?.[key]);
    if (configured) return configured;
    if (/cpu|processor/i.test(key)) return "CPU";
    if (/colou?r/i.test(key)) return "Color";
    if (/size/i.test(key)) return "Size";
    if (/style/i.test(key)) return "Style";
    return cleanVariantText(String(key || "").replace(/[_-]+/g, " ")) || "Variant";
  }

  function amazonTwisterTextSources() {
    const sources = [];
    const twisterText = document.querySelector("#twister_feature_div")?.textContent;
    if (twisterText) sources.push(twisterText);
    document.querySelectorAll("script").forEach((script) => {
      const text = script.textContent || "";
      if (/variationValues|dimensionValuesDisplayData|sortedDimValuesForAllDims|dimensionToAsinMap/i.test(text)) {
        sources.push(text);
      }
    });
    return sources;
  }

  function amazonTwisterVariantsFromDisplayData(data, context) {
    const displayData = data.dimensionValuesDisplayData;
    if (!displayData || typeof displayData !== "object") return [];
    const dimensions = Array.isArray(data.dimensions) ? data.dimensions : Object.keys(data.variationValues || {});
    const labels = data.variationDisplayLabels || {};
    return Object.entries(displayData).slice(0, 120).map(([asin, values], index) => {
      const list = Array.isArray(values) ? values.map(cleanVariantText).filter(Boolean) : [cleanVariantText(values)].filter(Boolean);
      const aspectValues = {};
      list.forEach((value, i) => {
        const key = dimensions[i] || `dimension_${i + 1}`;
        aspectValues[amazonVariationLabel(key, labels)] = value;
      });
      const variantImages = unique(context.images || [], 12);
      return {
        sku: cleanText(asin) || `${context.id}-v${index + 1}`,
        name: list.join(" / ") || context.title,
        price: context.price,
        priceCurrency: context.priceCurrency,
        image: variantImages[0] || null,
        images: variantImages,
        aspectValues,
      };
    }).filter((variant) => variant.name);
  }

  function amazonTwisterVariantsFromAsinMap(data, context) {
    const valuesByDimension = data.variationValues;
    const asinMap = data.dimensionToAsinMap;
    if (!valuesByDimension || typeof valuesByDimension !== "object" || !asinMap || typeof asinMap !== "object") return [];
    const dimensions = Object.keys(valuesByDimension);
    const labels = data.variationDisplayLabels || {};
    return Object.entries(asinMap).slice(0, 120).map(([comboKey, asin], index) => {
      const indices = String(comboKey).split(/[,_-]/).map((value) => Number(value));
      const aspectValues = {};
      const names = [];
      dimensions.forEach((dimension, i) => {
        const options = Array.isArray(valuesByDimension[dimension]) ? valuesByDimension[dimension] : [];
        const option = cleanVariantText(options[indices[i] ?? (dimensions.length === 1 ? Number(comboKey) : -1)]);
        if (!option) return;
        names.push(option);
        aspectValues[amazonVariationLabel(dimension, labels)] = option;
      });
      const variantImages = unique(context.images || [], 12);
      return {
        sku: cleanText(asin) || `${context.id}-v${index + 1}`,
        name: names.join(" / ") || context.title,
        price: context.price,
        priceCurrency: context.priceCurrency,
        image: variantImages[0] || null,
        images: variantImages,
        aspectValues,
      };
    }).filter((variant) => variant.name);
  }

  function amazonTwisterVariantsFromSortedDims(data, context) {
    const sortedDims = data.sortedDimValuesForAllDims;
    if (!sortedDims || typeof sortedDims !== "object") return [];
    const variants = [];
    for (const [dimension, items] of Object.entries(sortedDims)) {
      if (!Array.isArray(items)) continue;
      const label = amazonVariationLabel(dimension, data.variationDisplayLabels || {});
      for (const item of items.slice(0, 120)) {
        const value = cleanVariantText(item?.dimensionValueDisplayText);
        if (!value) continue;
        const variantImages = unique(context.images || [], 12);
        variants.push({
          sku: cleanText(item?.defaultAsin) || `${context.id}-v${variants.length + 1}`,
          name: value,
          price: context.price,
          priceCurrency: context.priceCurrency,
          image: variantImages[0] || null,
          images: variantImages,
          aspectValues: { [label]: value },
        });
        if (variants.length >= 120) return variants;
      }
    }
    return variants;
  }

  function extractAmazonTwisterVariants(context) {
    const merged = {};
    for (const source of amazonTwisterTextSources()) {
      const sorted = extractJsonObjectByKey(source, "sortedDimValuesForAllDims");
      const variationValues = extractJsonObjectByKey(source, "variationValues");
      const dimensionToAsinMap = extractJsonObjectByKey(source, "dimensionToAsinMap");
      const dimensionValuesDisplayData = extractJsonObjectByKey(source, "dimensionValuesDisplayData");
      const variationDisplayLabels = extractJsonObjectByKey(source, "variationDisplayLabels");
      if (sorted && !merged.sortedDimValuesForAllDims) merged.sortedDimValuesForAllDims = sorted;
      if (variationValues && !merged.variationValues) merged.variationValues = variationValues;
      if (dimensionToAsinMap && !merged.dimensionToAsinMap) merged.dimensionToAsinMap = dimensionToAsinMap;
      if (dimensionValuesDisplayData && !merged.dimensionValuesDisplayData) merged.dimensionValuesDisplayData = dimensionValuesDisplayData;
      if (variationDisplayLabels && !merged.variationDisplayLabels) merged.variationDisplayLabels = variationDisplayLabels;
    }

    const displayVariants = amazonTwisterVariantsFromDisplayData(merged, context);
    if (displayVariants.length) return displayVariants;
    const asinMapVariants = amazonTwisterVariantsFromAsinMap(merged, context);
    if (asinMapVariants.length) return asinMapVariants;
    return amazonTwisterVariantsFromSortedDims(merged, context);
  }

  function uniqueElements(nodes) {
    const out = [];
    const seen = new Set();
    for (const node of nodes || []) {
      if (!node || seen.has(node)) continue;
      seen.add(node);
      out.push(node);
    }
    return out;
  }

  function matchesAnySelector(el, selectors) {
    if (!el?.matches) return false;
    for (const selector of selectors || []) {
      try {
        if (el.matches(selector)) return true;
      } catch {}
    }
    return false;
  }

  function cleanVariantText(value) {
    const text = cleanText(value);
    if (!text) return null;
    const out = text
      .replace(/\.[A-Za-z0-9_-]+\{[^}]*\}/g, " ")
      .replace(/^(?:Bot[oó]n|Button)\s+\d+\s+(?:de|of)\s+\d+\s*,\s*/i, "")
      .replace(/\b\d+\s+options?\s+from\s+[$€£¥₹₽]?\s*[\d\s.,]+.*$/i, " ")
      .replace(/(?:超?\s*)?(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万]+)?\s*人加购/g, " ")
      .replace(/近期热销|热销|推荐|已选|无货|缺货|库存不足|到货通知/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return out || null;
  }

  function firstCleanVariantText(...values) {
    for (const value of values) {
      const text = cleanVariantText(value);
      if (text) return text;
    }
    return null;
  }

  function canonicalVariantLabel(value) {
    const label = cleanVariantText(value)?.replace(/[：:]\s*$/, "");
    if (!label) return null;
    if (/^(?:color|colour|colors|colours|color name)$/i.test(label)) return "Color";
    if (/^(?:size|sizes|size name)$/i.test(label)) return "Size";
    if (/^(?:style|styles|style name)$/i.test(label)) return "Style";
    return label;
  }

  function labelFromGroupIdentity(group) {
    const raw = cleanText([
      group?.id,
      typeof group?.className === "string" ? group.className : "",
      group?.getAttribute?.("name"),
      group?.getAttribute?.("aria-label"),
    ].filter(Boolean).join(" "));
    if (!raw) return null;
    if (/(?:^|[_\-\s])colou?rs?(?:[_\-\s]|$)|variation_color|color_name/i.test(raw)) return "Color";
    if (/(?:^|[_\-\s])sizes?(?:[_\-\s]|$)|variation_size|size_name/i.test(raw)) return "Size";
    if (/(?:^|[_\-\s])styles?(?:[_\-\s]|$)|variation_style|style_name/i.test(raw)) return "Style";
    return null;
  }

  function compactVariantText(value) {
    return String(value || "").replace(/\s+/g, "");
  }

  function isRejectedVariantLabel(text, config) {
    const label = canonicalVariantLabel(text);
    if (!label || label.length > 24) return true;
    if (/^(?:Color|Size|Style)$/.test(label)) return false;
    text = label;
    if (!text || text.length > 20) return true;
    if (/商品规格|切换大图|大图模式|选购更多|特色服务|保障服务/i.test(text)) return true;
    if (config?.rejectTitlePattern?.test(text)) return true;
    return false;
  }

  function hasNestedOptionCandidates(el, text, config) {
    const outerText = compactVariantText(text);
    if (!outerText) return false;
    const nested = uniqueElements((config?.variantOptionSelectors || []).flatMap((selector) => [...el.querySelectorAll(selector)]));
    const nestedValues = [];
    for (const node of nested) {
      const value = firstCleanVariantText(
        node.textContent,
        node.getAttribute?.("title"),
        node.getAttribute?.("aria-label"),
        node.querySelector?.("img")?.getAttribute?.("alt"),
        node.tagName?.toLowerCase() === "img" ? node.getAttribute?.("alt") : null,
      );
      if (!value || value === text) continue;
      const compact = compactVariantText(value);
      if (!compact || compact.length >= outerText.length) continue;
      if (!outerText.includes(compact)) continue;
      nestedValues.push(value);
      if (unique(nestedValues, 4).length >= 2) return true;
    }
    return false;
  }

  function elementImageList(el, config) {
    const raw = [];
    if (el?.tagName?.toLowerCase() === "img") pushImageElement(raw, el);
    el?.querySelectorAll?.("img").forEach((img) => pushImageElement(raw, img));
    pushStyleImages(raw, el);
    el?.querySelectorAll?.("[style]").forEach((child) => pushStyleImages(raw, child));
    return unique(raw.map((src) => normalizeImage(src, config)).filter(Boolean), 6);
  }

  function explicitLabelFromGroup(group, config) {
    for (const selector of config?.variantLabelSelectors || []) {
      const el = group.querySelector(selector);
      const text = cleanVariantText(el?.textContent);
      const canonical = canonicalVariantLabel(text);
      if (!isRejectedVariantLabel(canonical, config)) return canonical;
      if (!isRejectedVariantLabel(text, config)) return text.replace(/[：:]\s*$/, "");
    }
    const attr = canonicalVariantLabel(group.getAttribute?.("data-name") || group.getAttribute?.("data-title") || group.getAttribute?.("data-prop"));
    if (!isRejectedVariantLabel(attr, config)) return attr;
    return labelFromGroupIdentity(group);
  }

  function labelFromGroup(group, config, index) {
    return explicitLabelFromGroup(group, config) || `规格${index + 1}`;
  }

  function optionFromElement(el, label, config) {
    if (!el) return null;
    const context = elementContext(el);
    if (/disabled|disable|soldout|sold-out|unavailable/i.test(context) || el.disabled || el.getAttribute?.("aria-disabled") === "true") {
      return null;
    }
    const imgAlt = el.tagName?.toLowerCase() === "img"
      ? el.getAttribute?.("alt")
      : el.querySelector?.("img")?.getAttribute?.("alt");
    const text = firstCleanVariantText(el.getAttribute?.("title"), el.getAttribute?.("aria-label"), imgAlt, el.textContent);
    if (!text || text === label || text.length > 80) return null;
    if (hasNestedOptionCandidates(el, text, config)) return null;
    if (config?.rejectTitlePattern?.test(text)) return null;
    const images = elementImageList(el, config);
    return { value: text, images };
  }

  function extractDomVariantGroups(config) {
    const roots = uniqueElements((config?.variantRootSelectors || []).flatMap((selector) => [...document.querySelectorAll(selector)]));
    const groups = [];
    const seen = new Set();
    for (const root of roots) {
      const groupNodes = uniqueElements([
        ...(matchesAnySelector(root, config?.variantGroupSelectors) ? [root] : []),
        ...(config?.variantGroupSelectors || []).flatMap((selector) => [...root.querySelectorAll(selector)]),
      ]);
      for (const group of groupNodes) {
        const explicitLabel = explicitLabelFromGroup(group, config);
        if (!explicitLabel && matchesAnySelector(group.parentElement, config?.variantGroupSelectors)) continue;
        const label = labelFromGroup(group, config, groups.length);
        const optionNodes = uniqueElements((config?.variantOptionSelectors || []).flatMap((selector) => [...group.querySelectorAll(selector)]));
        const options = [];
        const optionSeen = new Set();
        for (const optionNode of optionNodes) {
          const option = optionFromElement(optionNode, label, config);
          if (!option || optionSeen.has(option.value)) continue;
          optionSeen.add(option.value);
          options.push(option);
        }
        if (!options.length || options.length > 80) continue;
        const key = `${label}:${options.map((item) => item.value).join("|")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        groups.push({ label, options });
        if (groups.length >= 4) return groups;
      }
    }
    return groups;
  }

  function expandDomVariants(config, { id, title, price, priceCurrency, images }) {
    const groups = extractDomVariantGroups(config);
    if (!groups.length) return [];
    const combinations = [{ values: [], optionImages: [] }];
    for (const group of groups) {
      const next = [];
      for (const combo of combinations) {
        for (const option of group.options) {
          next.push({
            values: [...combo.values, { label: group.label, value: option.value }],
            optionImages: [...combo.optionImages, ...(option.images || [])],
          });
          if (next.length >= 120) break;
        }
        if (next.length >= 120) break;
      }
      combinations.splice(0, combinations.length, ...next);
    }

    return combinations.slice(0, 120).map((combo, index) => {
      const aspectValues = {};
      combo.values.forEach((item) => {
        aspectValues[item.label] = item.value;
      });
      const variantImages = unique([...combo.optionImages, ...(images || [])], 12);
      const name = combo.values.map((item) => item.value).join(" / ");
      return {
        sku: `${id}-v${index + 1}`,
        name: name || title,
        price,
        priceCurrency,
        image: variantImages[0] || null,
        images: variantImages,
        aspectValues,
      };
    });
  }

  function textFromFirstSelector(root, selectors) {
    for (const selector of selectors || []) {
      const el = root?.querySelector?.(selector);
      const text = cleanVariantText(el?.textContent || el?.getAttribute?.("title") || el?.getAttribute?.("aria-label"));
      if (text) return text;
    }
    return null;
  }

  function variantRowLabel(config) {
    for (const selector of config?.variantRowLabelSelectors || []) {
      const text = cleanVariantText(document.querySelector(selector)?.textContent);
      if (!isRejectedVariantLabel(text, config)) return text.replace(/[：:]\s*$/, "");
    }
    return "规格";
  }

  function extractDomVariantRows(config, { id, title, price, priceCurrency, images }) {
    const rows = uniqueElements((config?.variantListRowSelectors || []).flatMap((selector) => [...document.querySelectorAll(selector)]));
    if (!rows.length) return [];
    const label = variantRowLabel(config);
    const variants = [];
    const seen = new Set();
    for (const row of rows.slice(0, 120)) {
      const name = textFromFirstSelector(row, config?.variantRowNameSelectors)
        || cleanVariantText(row.textContent);
      if (!name || seen.has(name) || name.length > 80) continue;
      seen.add(name);
      const rowImages = elementImageList(row, config);
      const variantImages = unique([...rowImages, ...(images || [])], 12);
      const rowPriceText = textFromFirstSelector(row, config?.variantRowPriceSelectors);
      const rowPrice = moneyFromText(rowPriceText) || price;
      const rowPriceCurrency = currencyFromText(rowPriceText, config) || priceCurrency;
      variants.push({
        sku: `${id}-v${variants.length + 1}`,
        name: name || title,
        price: rowPrice,
        priceCurrency: rowPriceCurrency,
        image: variantImages[0] || null,
        images: variantImages,
        aspectValues: { [label]: name },
      });
    }
    return variants;
  }

  function extractTemuSelectedOfferVariant(config, { id, title, price, priceCurrency, images }) {
    if (config?.sourceId !== "temu") return [];
    const nodes = uniqueElements([...document.querySelectorAll("div, span, p, section")]);
    for (const node of nodes) {
      const text = cleanText(node?.textContent);
      if (!text || text.length > 180 || !/^(?:颜色|顏色|Color)\s*[:：]/i.test(text)) continue;
      const colorMatch = text.match(/(?:颜色|顏色|Color)\s*[:：]\s*([^,，;；]+?)(?=\s*[,，;；]\s*(?:数量|數量|Qty|Quantity)\s*[:：]|$)/i);
      const quantityMatch = text.match(/(?:数量|數量|Qty|Quantity)\s*[:：]\s*([^,，;；]+?)(?=\s+(?:数量|數量|Qty|Quantity)(?:\s|[:：])|$)/i);
      const color = cleanVariantText(colorMatch?.[1]);
      const quantity = cleanVariantText(quantityMatch?.[1]);
      if (!color) continue;
      const aspectValues = { 颜色: color };
      if (quantity) aspectValues["数量"] = quantity;
      const variantImages = unique([...(images || [])], 12);
      return [{
        sku: `${id}-selected`,
        name: color || title,
        price,
        priceCurrency,
        image: variantImages[0] || null,
        images: variantImages,
        aspectValues,
      }];
    }
    return [];
  }

  function isExcludedGlobalDetailPath(pathname) {
    return /^\/(?:$|search|cart|basket|category|categories|channel|login|signin|orders|support|help|customer|mall|store|stores|wishlist|user|account)\b/i.test(pathname || "/");
  }

  function detectPlatform() {
    const host = location.hostname;
    const href = location.href;
    const pathname = location.pathname || "/";
    if (/item\.jd\.com$/i.test(host) || /item\.m\.jd\.com$/i.test(host)) return PLATFORM_CONFIGS.jd;
    if (/^pifa\.pinduoduo\.com$/i.test(host)) return PLATFORM_CONFIGS.pdd;
    if (/taobao\.com$/i.test(host) || /tmall\.com$/i.test(host)) return PLATFORM_CONFIGS.taobao;
    if (/amazon\./i.test(host) && /\/(?:dp|gp\/product)\/[A-Z0-9]{10}/i.test(href)) return PLATFORM_CONFIGS.amazon;
    if (/wildberries\.ru$/i.test(host) && /\/catalog\/\d+\/detail\.aspx/i.test(href)) return PLATFORM_CONFIGS.wb;
    if (/temu\./i.test(host) && (/(?:[?&]goods_id=\d+|\/\d{8,})/i.test(href) || (!isExcludedGlobalDetailPath(pathname) && pathname.length > 1))) return PLATFORM_CONFIGS.temu;
    if (/mercadolibre\./i.test(host) && /(?:\/[A-Z]{3}-\d+|\/p\/[A-Z]{3}\d+)/i.test(href)) return PLATFORM_CONFIGS.mercadolibre;
    if (/market\.yandex\./i.test(host) && /(?:\/product--[^/]+\/\d+|\/card\/[^/]+\/\d+|[?&](?:sku|productId|modelid|id)=\d+)/i.test(href)) return PLATFORM_CONFIGS.yandex;
    if (/shein\./i.test(host) && (/(?:[?&](?:goods_id|goods_sn)=\w+|-p-[A-Za-z0-9]+)/i.test(href) || (/\.html(?:[?#]|$)/i.test(href) && !isExcludedGlobalDetailPath(pathname)))) return PLATFORM_CONFIGS.shein;
    if (/jd\.com\/\d+\.html/i.test(href)) return PLATFORM_CONFIGS.jd;
    return null;
  }

  function buildPayload(platformConfig = detectPlatform()) {
    const config = platformConfig;
    if (!config) return null;
    const structured = findStructuredData(config);
    const platform = /tmall\.com/i.test(location.hostname) ? "tmall" : config.sourceId;
    const id = cleanText(pick(structured, config.idKeys)) || config.idFromUrl(location.href);
    if (!id) return null;
    const title = chooseProductTitle(structured, config);
    if (!title) return null;
    const images = normalizeImageList(structured.images, config);
    const seller = normalizeSeller(structured, config);
    const structuredPriceInfo = moneyInfoFromText(structured.price, config, structured.priceCurrency);
    const selectorPriceInfo = structuredPriceInfo?.price ? null : moneyInfoFromSelectors(config.priceSelectors, config);
    const visibleCurrencyPriceInfo = (structuredPriceInfo?.price || selectorPriceInfo?.price)
      ? null
      : moneyInfoFromVisibleCurrencyNodes(config);
    const bodyPriceInfo = (structuredPriceInfo?.price || selectorPriceInfo?.price || !allowBodyPriceFallback(config))
      ? null
      : moneyInfoFromText(document.body?.innerText, config);
    const priceInfo = structuredPriceInfo || selectorPriceInfo || visibleCurrencyPriceInfo || bodyPriceInfo;
    const price = priceInfo?.price || null;
    const priceCurrency = priceInfo?.currency || normalizeCurrencyCode(structured.priceCurrency) || undefined;
    const originalPrice = moneyFromText(structured.originalPrice);
    const structuredVariants = normalizeVariants(structured.variants, config);
    const amazonTwisterVariants = config.sourceId === "amazon"
      ? extractAmazonTwisterVariants({ id, title, price, priceCurrency, images })
      : [];
    const domVariants = expandDomVariants(config, { id, title, price, priceCurrency, images });
    const rowVariants = extractDomVariantRows(config, { id, title, price, priceCurrency, images });
    const temuSelectedOfferVariants = extractTemuSelectedOfferVariant(config, { id, title, price, priceCurrency, images });
    let variants = structuredVariants;
    if (amazonTwisterVariants.length > variants.length) variants = amazonTwisterVariants;
    if (domVariants.length > variants.length) variants = domVariants;
    if (rowVariants.length >= variants.length && rowVariants.length) variants = rowVariants;
    if (!variants.length && temuSelectedOfferVariants.length) variants = temuSelectedOfferVariants;

    return {
      productId: config.sourceId === "jd" ? id : undefined,
      asin: config.sourceId === "amazon" ? id : undefined,
      nmId: config.sourceId === "wb" ? id : undefined,
      goodsId: (config.sourceId === "pdd" || config.sourceId === "temu") ? id : undefined,
      mlItemId: config.sourceId === "mercadolibre" ? id : undefined,
      yandexSku: config.sourceId === "yandex" ? id : undefined,
      goodsSn: config.sourceId === "shein" ? id : undefined,
      itemId: config.sourceId === "taobao" ? id : undefined,
      sku: id,
      title,
      price,
      priceCurrency,
      originalPrice,
      images,
      mainImages: images,
      image: images[0] || null,
      videoUrl: cleanText(structured.videoUrl),
      videoCover: normalizeImage(structured.videoCover, config),
      brandName: cleanText(structured.brandName),
      seller,
      variants,
      platform,
      url: location.href.split("#")[0],
    };
  }

  window.JZCnSourceScraper = {
    detectPlatform,
    buildPayload,
    _internals: {
      cleanText,
      normalizeImage,
      moneyFromText,
      currencyFromText,
      structuredRoots,
    },
  };
})();
