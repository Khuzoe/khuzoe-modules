export function normalizeSearch(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
}

export function slugify(value, fallback = "entity") {
    return normalizeSearch(value).replace(/\s+/g, "-") || fallback;
}

export function normalizeWikiItemKey(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, "");
}

export function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, char => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#039;"
    })[char]);
}

export function appendEmbedParam(url) {
    const separator = String(url || "").includes("?") ? "&" : "?";
    return `${url}${separator}embed=1`;
}

export function withCampaign(url, campaignId) {
    const target = new URL(url);
    target.searchParams.set("campaign", campaignId);
    return target.toString();
}
