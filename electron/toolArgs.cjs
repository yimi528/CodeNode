'use strict';
function canonicalArgs(raw) {
  try {
    const obj = JSON.parse(raw);
    const sort = (o) => {
      if (Array.isArray(o)) return o.map(sort);
      if (o && typeof o === 'object') {
        return Object.keys(o)
          .sort()
          .reduce((acc, k) => {
            acc[k] = sort(o[k]);
            return acc;
          }, {});
      }
      return o;
    };
    return JSON.stringify(sort(obj));
  } catch {
    return String(raw || '').trim();
  }
}

module.exports = { canonicalArgs };
