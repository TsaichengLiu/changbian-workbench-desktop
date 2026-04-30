const path = require("path");
const fs = require("fs");

function loadSupportedSites(appRoot) {
  const file = path.join(appRoot, "src", "supported-sites.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Ignore and return fallback list.
  }
  return [];
}

module.exports = { loadSupportedSites };
