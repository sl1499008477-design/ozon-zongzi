function markerList(markers) {
  return [...new Set(
    (Array.isArray(markers) ? markers : [markers])
      .map((marker) => String(marker || ""))
      .filter(Boolean),
  )];
}

function objectPath(path, key) {
  return typeof key === "symbol"
    ? `${path}[${String(key)}]`
    : `${path}.${String(key)}`;
}

export function findSensitiveMarkersDeep(value, markers) {
  const expectedMarkers = markerList(markers);
  const findings = [];
  const visited = new WeakSet();

  function visit(current, path) {
    if (typeof current === "string") {
      for (const marker of expectedMarkers) {
        if (current.includes(marker)) findings.push({ path, marker });
      }
      return;
    }
    if ((typeof current !== "object" && typeof current !== "function") || current === null) return;
    if (visited.has(current)) return;
    visited.add(current);

    const explicitErrorKeys = new Set();
    if (current instanceof Error) {
      for (const key of ["name", "message", "code", "cause"]) {
        explicitErrorKeys.add(key);
        visit(current[key], objectPath(path, key));
      }
    }
    if (Array.isArray(current)) {
      current.forEach((nested, index) => visit(nested, `${path}[${index}]`));
      return;
    }
    for (const key of Reflect.ownKeys(current)) {
      if (explicitErrorKeys.has(key)) continue;
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) continue;
      visit(descriptor.value, objectPath(path, key));
    }
  }

  visit(value, "$loggerArgs");
  return findings;
}

export function assertNoSensitiveMarkersDeep(value, markers) {
  const findings = findSensitiveMarkersDeep(value, markers);
  if (findings.length) {
    throw new Error(`Sensitive observability marker detected at ${findings[0].path}`);
  }
}
