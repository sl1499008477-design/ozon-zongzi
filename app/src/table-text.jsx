import React from "react";

export const sourceCellText = (value) =>
  value === null || value === undefined || value === "" ? "—" : String(value);

export const renderSourceTextCell = (value) => {
  const text = sourceCellText(value);
  return <span className="source-table-cell-text" title={text}>{text}</span>;
};

export const safeExternalHttpUrl = (value) => {
  const text = sourceCellText(value).trim();
  if (!/^https?:\/\//i.test(text)) return "";
  try {
    return new URL(text).href;
  } catch {
    return "";
  }
};

const visualTextUnits = (value) => Array.from(sourceCellText(value)).reduce((sum, char) =>
  sum + (/[\u2e80-\u9fff\uac00-\ud7af]/.test(char) ? 2 : 1)
, 0);

export const adaptiveTextColumnWidth = (
  rows,
  dataIndex,
  { min = 120, max = 260, padding = 56 } = {},
) => {
  const longest = rows.reduce(
    (current, row) => Math.max(current, visualTextUnits(row?.[dataIndex])),
    visualTextUnits(dataIndex),
  );
  return Math.min(max, Math.max(min, longest * 7 + padding));
};
