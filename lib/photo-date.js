// Working out when a photo was taken, shared by the slideshow and the library index
// (which stores the result so Day mode can look photos up by date).

export const isPhotoItem = (i) => i.type === 'item' && (
    (i.class && i.class.toLowerCase().indexOf('imageitem') >= 0) ||
    (i.protocolInfo && i.protocolInfo.includes('image/')) ||
    (i.title && i.title.match(/\.(jpg|jpeg|png|gif|webp)$/i))
);

// Extract the best available date from a cached image item.
// Returns a Date object or null. Checks dc:date field, then folder path, then title.
export function getImageDate(img) {
    // 1. dc:date field (stored as img.year by media-server)
    const dateStr = img.year || img.date || img['dc:date'];
    if (dateStr) {
        const d = new Date(dateStr);
        if (!isNaN(d.getTime())) return d;
    }

    // 2. Folder path segments (stored as JSON array of {id, title})
    try {
        const pathSegments = JSON.parse(img._path || '[]');
        // Scan from innermost folder outward
        for (let i = pathSegments.length - 1; i >= 0; i--) {
            const parsed = extractDateFromString(pathSegments[i].title);
            if (parsed && parsed.month && parsed.day) {
                return new Date(`${parsed.year}-${parsed.month}-${parsed.day}`);
            }
        }
    } catch (e) { /* ignore */ }

    // 3. Item title / filename
    const parsed = extractDateFromString(img.title);
    if (parsed && parsed.month && parsed.day) {
        return new Date(`${parsed.year}-${parsed.month}-${parsed.day}`);
    }

    return null;
}

// "MM-DD" of a date, in local time: what Day mode matches on
export function monthDay(d) {
    return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// A photo's date as "YYYY-MM-DD" for the library index, or null if it isn't a photo or has none
export function photoDateString(item) {
    if (!isPhotoItem(item)) return null;
    const d = getImageDate(item);
    return d ? `${d.getFullYear()}-${monthDay(d)}` : null;
}

export function extractDateFromString(str) {
    if (!str) return null;
    // YYYY-MM-DD or YYYY_MM_DD or YYYY.MM.DD
    let m = str.match(/\b((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])[-_.]((0[1-9]|[12]\d|3[01]))\b/);
    if (m) return { year: m[1], month: m[2], day: m[3] };
    // YYYYMMDDHHMMSS (must be checked before YYYYMMDD to avoid partial match)
    m = str.match(/\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])([01]\d|2[0-3])([0-5]\d)([0-5]\d)\b/);
    if (m) return { year: m[1], month: m[2], day: m[3] };
    // YYYYMMDD
    m = str.match(/\b((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
    if (m) return { year: m[1], month: m[2], day: m[3] };
    // YYYY-MM or YYYY_MM
    m = str.match(/\b((?:19|20)\d{2})[-_.](0[1-9]|1[0-2])\b/);
    if (m) return { year: m[1], month: m[2], day: null };
    // YYYY alone
    m = str.match(/\b((?:19|20)\d{2})\b/);
    if (m) return { year: m[1], month: null, day: null };
    // XX-XX-XX at the start: underscore after → DD-MM-YY, otherwise → YY-MM-DD
    m = str.match(/^(\d{2})[-_.](\d{2})[-_.](\d{2})_/);
    if (m) {
        // DD-MM-YY_ e.g. "15-03-24_photo.jpg"
        const yy = parseInt(m[3], 10);
        const year = (yy >= 70 ? 1900 + yy : 2000 + yy).toString();
        return { year, month: m[2], day: m[1] };
    }
    m = str.match(/^(\d{2})[-_.](\d{2})[-_.](\d{2})/);
    if (m) {
        // YY-MM-DD e.g. "24-03-15-photo.jpg"
        const yy = parseInt(m[1], 10);
        const year = (yy >= 70 ? 1900 + yy : 2000 + yy).toString();
        return { year, month: m[2], day: m[3] };
    }
    return null;
}
