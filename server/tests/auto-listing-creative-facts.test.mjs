import assert from "node:assert/strict";
import test from "node:test";
import { isAutoListingCreativeFact } from "../auto-listing-creative-facts.mjs";

test("accepted source-image facts keep unsafe kinds out of creative projections", () => {
  for (const kind of [
    "CERTIFICATION", "WARRANTY", "EXTERNAL_OVERLAY", "PROMOTION", "FORBIDDEN_TEXT",
  ]) {
    assert.equal(isAutoListingCreativeFact({
      factId: `source-fact-${"1".repeat(24)}`,
      kind,
      value: "EAC",
    }), false, kind);
  }
  assert.equal(isAutoListingCreativeFact({
    factId: `source-fact-${"2".repeat(24)}`,
    kind: "WEIGHT",
    value: "300 г",
  }), true);
});

test("safe V2 image semantics remain creative while unsafe values stay excluded", () => {
  for (const [kind, value] of [
    ["IMAGE_SELLING_POINT", "Автоматическое срабатывание"],
    ["IMAGE_USAGE", "Для электрических шкафов"],
    ["IMAGE_USAGE_STEP", "Закрепите устройство на DIN-рейке"],
    ["IMAGE_SPECIFICATION", "Рабочий ток 20 А"],
    ["IMAGE_PACKAGE_CONTENT", "В комплекте 3 штуки"],
    ["IMAGE_CAUTION", "Не устанавливать рядом с водой"],
    ["IMAGE_PRODUCT_IDENTITY", "Термовыключатель"],
  ]) {
    assert.equal(isAutoListingCreativeFact({ factId: `source-fact-${"3".repeat(24)}`, kind, value }), true, kind);
  }
  for (const value of ["Скидка 50%", "seller.example", "+7 900 000 00 00", "Сертификация: CE"]) {
    assert.equal(isAutoListingCreativeFact({
      factId: `source-fact-${"4".repeat(24)}`,
      kind: "IMAGE_SELLING_POINT",
      value,
    }), false, value);
  }
});

test("Ozon platform-only grouping and UOM fields never become image copy", () => {
  for (const fact of [{
    factId: "fact.attribute.22390.0",
    kind: "ATTRIBUTE:22390",
    value: "Объединить в похожие товары: противопожарная система",
  }, {
    factId: "fact.attribute.23249.0",
    kind: "ATTRIBUTE:23249",
    value: "Количество товара в УЕИ: 3",
  }, {
    factId: "fact.attribute.future-platform-field.0",
    kind: "ATTRIBUTE:future-platform-field",
    value: "Объединить в похожие товары: автоматическая установка",
  }]) {
    assert.equal(isAutoListingCreativeFact(fact), false, fact.value);
  }

  assert.equal(isAutoListingCreativeFact({
    factId: "fact.attribute.8962.0",
    kind: "ATTRIBUTE:8962",
    value: "Единиц в одном товаре: 3",
  }), true);
});
