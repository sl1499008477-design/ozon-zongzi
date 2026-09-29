// No-brand is a text publication choice. Source records and media URLs stay intact.
import { collectedAttributeValues } from './collector-attribute-values.mjs';
import { flattenHashtagInput, normalizeAttributeValues } from './ozon-import-normalizer.mjs';
import { EntityDecoder, ALL_ENTITIES } from '@nodable/entities';

const proseFields = new Set(['name', 'title', 'description', 'descriptionHTML', 'scraped_description',
  'webDescription', 'model_name', 'modelName', 'scraped_model_name']);
const proseAttributes = new Set([4180, 4191, 9048, 21837]);
const tagAttributes = new Set([23171, 22508]);
const richTextFields = new Set(['text', 'content', 'title', 'subtitle', 'caption', 'alt', 'description']);
const xiaomiNames = ['Xiaomi', 'Mijia', '小米', '米家', 'Сяоми', 'Миджия'];
const array = value => Array.isArray(value) ? value : [];
const attributeId = attr => Number(attr?.id || attr?.key || attr?.attribute_id || attr?.attributeId);
const attributeValues = attr => normalizeAttributeValues(collectedAttributeValues(attr));
const entities = new EntityDecoder({ namedEntities: ALL_ENTITIES });

export function removeAiListingBrandText(item, ...sourceFacts) {
  const carriers = [item, item._sourceVariant, item._bundleItem, item._sourceVariant?._bundleItem].filter(Boolean);
  const brands = new Set();
  for (const source of [...carriers, ...sourceFacts].filter(Boolean)) {
    for (const value of [source.brand, source.brandName, ...array(source.attributes)
      .filter(attr => attributeId(attr) === 85)
      .flatMap(attr => attributeValues(attr).map(value => value.value))]) {
      if (typeof value === 'string' && value.trim() && !/^(Нет бренда|no brand|без бренда|无品牌)$/iu.test(value.trim())) brands.add(value.trim());
    }
  }
  if ([...brands].some(brand => xiaomiNames.some(alias => alias.toLowerCase() === brand.toLowerCase()))) {
    for (const alias of xiaomiNames) brands.add(alias);
  }
  if (!brands.size) return;
  const patterns = [...brands].sort((a,b) => b.length-a.length).map(brand => {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return /\p{Script=Han}/u.test(brand) ? escaped : `(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`;
  });
  const expression = new RegExp(patterns.join('|'), 'giu');
  const hasBrand = value => {expression.lastIndex=0;return typeof value==='string' && expression.test(value);};
  const clean = (value, trim = true) => {
    if (!hasBrand(value)) return value;
    const text = value.replace(expression, '').replace(/[ \t]{2,}/g, ' ')
      .replace(/\s+([,.;:!?，。；：！？])/g, '$1');
    return trim ? text.trim() : text;
  };
  const tags = value => {
    const kept = flattenHashtagInput(value).filter(tag => !hasBrand(entities.decode(tag)));
    return Array.isArray(value) ? kept : kept.join(' ');
  };
  const html = value => {
    if (typeof value !== 'string' || !/[<&]/u.test(value)) return clean(value);
    // Match rendered text, including inline tags and HTML entities. Map only
    // matching text back to source tokens so media URLs/markup remain intact.
    const tokens = value.match(/<!--[\s\S]*?-->|<\/?[a-z](?:"[^"]*"|'[^']*'|[^'">])*>|&(?:#x[\da-f]+|#\d+|[a-z][\da-z]*);|[\s\S]/giu) || [];
    const positions = [];
    let visible = '';
    for (const [index, token] of tokens.entries()) {
      const isTag = token.startsWith('<') && token.length > 1;
      const text = isTag ? (/^<\/?(?:p|br|div|li|h[1-6])(?:\s|\/?>)/iu.test(token) ? '\n' : '') : entities.decode(token);
      visible += text;
      for (let i = 0; i < text.length; i++) positions.push(isTag ? -1 : index);
    }
    if (!hasBrand(visible)) return value;
    expression.lastIndex = 0;
    const removed = new Set();
    for (const match of visible.matchAll(expression)) {
      let start = match.index, end = start + match[0].length;
      // Keep punctuation and word spacing readable after the brand is gone.
      if (/^[,.;:!?，。；：！？]/u.test(visible.slice(end))) while (start > 0 && /[ \t]/u.test(visible[start - 1])) start--;
      else if (start === 0 || /\s/u.test(visible[start - 1])) while (/[ \t]/u.test(visible[end] || '\n')) end++;
      for (let i = start; i < end; i++) if (positions[i] >= 0) removed.add(positions[i]);
    }
    return tokens.filter((_, index) => !removed.has(index)).join('').trim();
  };
  const rich = (value, key='') => {
    if (Array.isArray(value)) return value.map(child => rich(child,key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rich(v,k)]));
    return richTextFields.has(key) ? html(value) : value;
  };
  const richJson = value => {if(typeof value !== 'string')return rich(value);try{return JSON.stringify(rich(JSON.parse(value)));}catch{return value;}};
  const cleanAttributes = attrs => {
    for (const attr of array(attrs)) {
      const id = attributeId(attr);
      if (!proseAttributes.has(id) && !tagAttributes.has(id) && id!==11254) continue;
      attr.values = attributeValues(attr).map((value, index) => {
        const text = id === 11254 ? richJson(value.value) : tagAttributes.has(id) ? tags(value.value) : html(value.value);
        return { ...value, value: id === 21837 && !text ? `Видео ${index + 1}` : text };
      });
    }
  };
  for (const carrier of carriers) {
    for (const key of proseFields) if (typeof carrier[key]==='string') carrier[key]=html(carrier[key]);
    for (const key of ['tags','hashtags','_aiHashtags']) if(carrier[key]!==undefined)carrier[key]=tags(carrier[key]);
    for (const key of ['richContent','rich_content']) if(carrier[key]!==undefined)carrier[key]=richJson(carrier[key]);
    cleanAttributes(carrier.attributes);
    cleanAttributes(carrier.bundleComplexAttrs);
    cleanAttributes(carrier._bundleComplexAttrs);
    for(const group of array(carrier.complex_attributes))cleanAttributes(group.attributes);
    for (const [index, video] of array(carrier.videos).entries()) {
      if (video && typeof video === 'object') for (const key of ['name', 'title']) {
        if (video[key]) video[key] = html(video[key]) || `Видео ${index + 1}`;
      }
    }
  }
}
