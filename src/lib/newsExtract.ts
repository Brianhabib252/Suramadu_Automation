/**
 * DOM extraction utilities that collect article content, metadata, and quality
 * signals from the Suramadu news detail page. These signals feed both the
 * local policy engine and the Gemini-powered review.
 */
import type { Page } from 'playwright';

export interface ExtractedImage {
  src: string;
  alt: string;
}

export interface NewsSignals {
  paragraphCount: number;
  minSentencesPerParagraph: number;
  imageCount: number;
  allowedHostCount: number;
  hostedImageCount: number;
  sentenceCount: number;
}

export interface NewsExtractionResult {
  html: string;
  text: string;
  images: ExtractedImage[];
  eventDate?: string;
  uploadDate?: string;
  signals: NewsSignals;
}

type RawExtraction = {
  html: string;
  text: string;
  images: ExtractedImage[];
  eventDate?: string;
  uploadDate?: string;
  paragraphs: string[];
};

const IMAGE_HOST_ALLOWLIST = new Set(['i.ibb.co', 'imgbb.com']);

/**
 * Scrape the active article view, returning raw HTML/text, discovered images,
 * the parsed event date, and aggregate signals (sentence counts, host usage,
 * etc.) that drive downstream policy checks.
 */
export async function extractNews(page: Page): Promise<NewsExtractionResult> {
  const pageUrl = page.url();
  const raw = await page.evaluate<RawExtraction>(() => {
    const textarea = document.querySelector(
      'textarea#editor[name="deskripsi"]',
    ) as HTMLTextAreaElement | null;

    let html = '';
    let text = '';
    let container: HTMLElement | null = null;

    const selectByXPath = (expression: string): HTMLElement | null => {
      try {
        const result = document.evaluate(
          expression,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        const node = result.singleNodeValue;
        return node instanceof HTMLElement ? node : null;
      } catch {
        return null;
      }
    };

    const descriptionContainer = selectByXPath(
      '//*[@id="form-blog"]/div[5]/div/div/div[2]',
    );
    if (descriptionContainer) {
      container = descriptionContainer;
      html = descriptionContainer.innerHTML;
      text = descriptionContainer.innerText.trim();
    }

    if (
      !container &&
      textarea &&
      typeof textarea.value === 'string' &&
      textarea.value.trim()
    ) {
      html = textarea.value;
      const temp = document.createElement('div');
      temp.innerHTML = textarea.value;
      container = temp;
      text = temp.innerText.trim();
    } else if (!container) {
      const editable = document.querySelector('.ck-editor__editable');
      if (editable instanceof HTMLElement) {
        html = editable.innerHTML;
        text = editable.innerText.trim();
        container = editable;
      }
    }

    if (!container) {
      const fallbackSelectors = [
        '.ck-content',
        '[data-field="deskripsi"]',
        '#deskripsi',
        '.deskripsi',
        'article',
      ];
      for (const selector of fallbackSelectors) {
        const el = document.querySelector(selector);
        if (el instanceof HTMLElement) {
          container = el;
          if (!html) {
            html = el.innerHTML;
          }
          if (!text) {
            text = el.innerText.trim();
          }
          break;
        }
      }
    }

    if (!text && container) {
      text = container.innerText.trim();
    }

    if (!text) {
      text = document.body?.innerText?.trim() ?? '';
    }

    if (!html) {
      html = text;
    }

    const scope = container ?? document;
    const imgElements = Array.from(
      scope.querySelectorAll('img'),
    ) as HTMLImageElement[];
    const images = imgElements.map((img) => ({
      src: (img.getAttribute('src') || '').trim(),
      alt: (img.getAttribute('alt') || '').trim(),
    }));

    let paragraphs: string[] = [];
    if (container) {
      paragraphs = Array.from(container.querySelectorAll('p'))
        .map((p) => p.innerText.trim())
        .filter(Boolean);
    }
    if (paragraphs.length === 0 && text) {
      paragraphs = text
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
    }

    const dateSelectors = [
      'input[name="tanggal_event"]',
      'input[name="tanggal_kegiatan"]',
      'input[name="tanggal"]',
      'input[name="tgl_event"]',
      'input[name="tgl_kegiatan"]',
      'input[name="event_date"]',
      '[data-field="tanggal"] input',
      '[name="tanggal_acara"]',
      'input[type="date"]',
    ];

    let eventDate: string | undefined;
    for (const selector of dateSelectors) {
      const input = document.querySelector(selector) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (input && typeof input.value === 'string' && input.value.trim()) {
        eventDate = input.value.trim();
        break;
      }
    }

    if (!eventDate) {
      const textSelectors = [
        '[data-field="tanggal"]',
        '.tanggal-kegiatan',
        '.event-date',
        '.detail-tanggal',
      ];
      for (const selector of textSelectors) {
        const el = document.querySelector(selector);
        if (el?.textContent) {
          const candidate = el.textContent.replace(/\s+/g, ' ').trim();
          if (candidate) {
            eventDate = candidate;
            break;
          }
        }
      }
    }

    const uploadDateSelectors = [
      '#autoclose-datepicker',
      'input[name="tanggal_upload"]',
      'input[name="tanggal_publish"]',
      'input[name="tanggal_posting"]',
    ];
    let uploadDate: string | undefined;
    for (const selector of uploadDateSelectors) {
      const input = document.querySelector(selector) as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (input && typeof (input as HTMLInputElement).value === 'string') {
        const candidate = (input as HTMLInputElement).value.trim();
        if (candidate) {
          uploadDate = candidate;
          break;
        }
      }
    }

    if (!uploadDate) {
      const uploadNode = selectByXPath('//*[@id="autoclose-datepicker"]');
      if (
        uploadNode instanceof HTMLInputElement &&
        typeof uploadNode.value === 'string' &&
        uploadNode.value.trim()
      ) {
        uploadDate = uploadNode.value.trim();
      } else if (uploadNode?.textContent) {
        const candidate = uploadNode.textContent.replace(/\s+/g, ' ').trim();
        if (candidate) {
          uploadDate = candidate;
        }
      }
    }

    return { html, text, images, eventDate, uploadDate, paragraphs };
  });

  const images = raw.images.map(normalizeImage);
  const nonEmptyImages = images.filter((img) => img.src !== '');
  let pageHost: string | undefined;
  try {
    pageHost = new URL(pageUrl).hostname.toLowerCase();
  } catch {
    pageHost = undefined;
  }
  const allowedHostCount = nonEmptyImages.reduce((count, img) => {
    return count + (isAllowedHost(img.src, pageUrl) ? 1 : 0);
  }, 0);
  const hostedImageCount = nonEmptyImages.reduce((count, img) => {
    try {
      const url = new URL(img.src, pageUrl);
      const protocol = url.protocol.toLowerCase();
      if (protocol !== 'http:' && protocol !== 'https:') {
        return count;
      }
      if (!pageHost) {
        return count + 1;
      }
      return url.hostname.toLowerCase() !== pageHost ? count + 1 : count;
    } catch {
      return count;
    }
  }, 0);

  const paragraphs = raw.paragraphs.map((p) => p.trim()).filter(Boolean);
  const paragraphCount = paragraphs.length;
  const sentencesPerParagraph = paragraphs.map(countSentences);
  const minSentences =
    paragraphCount > 0 ? Math.min(...sentencesPerParagraph) : 0;
  const sentenceCount = sentencesPerParagraph.reduce(
    (total, count) => total + count,
    0,
  );

  const eventDateISO = normalizeDate(raw.eventDate);
  const uploadDateISO = normalizeDate(raw.uploadDate);

  return {
    html: raw.html,
    text: raw.text,
    images,
    eventDate: eventDateISO,
    uploadDate: uploadDateISO,
    signals: {
      paragraphCount,
      minSentencesPerParagraph: minSentences,
      imageCount: nonEmptyImages.length,
      allowedHostCount,
      hostedImageCount,
      sentenceCount,
    },
  };
}

function normalizeImage(image: ExtractedImage): ExtractedImage {
  return {
    src: image.src.trim(),
    alt: image.alt.trim(),
  };
}

function isAllowedHost(src: string, baseUrl: string): boolean {
  try {
    const url = new URL(src, baseUrl);
    return IMAGE_HOST_ALLOWLIST.has(url.hostname);
  } catch {
    return false;
  }
}

function countSentences(text: string): number {
  if (!text) {
    return 0;
  }
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/["“”]/g, '"')
    .trim();
  if (!normalized) {
    return 0;
  }

  const segments = normalized
    .split(/[.!?]+/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.length;
}

function normalizeDate(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const cleaned = value.replace(/\(.*?\)/g, '').trim();
  if (!cleaned) {
    return undefined;
  }

  const isoMatch = cleaned.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    const [, year, month, day] = isoMatch;
    const iso = toIsoDate(Number(year), Number(month), Number(day));
    if (iso) {
      return iso;
    }
  }

  const dmyMatch = cleaned.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const [, day, month, year] = dmyMatch;
    const iso = toIsoDate(Number(year), Number(month), Number(day));
    if (iso) {
      return iso;
    }
  }

  const textualMatch = cleaned.match(
    /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/u,
  );
  if (textualMatch) {
    const [, day, monthName, year] = textualMatch;
    const month = monthFromName(monthName);
    if (month !== undefined) {
      const iso = toIsoDate(Number(year), month + 1, Number(day));
      if (iso) {
        return iso;
      }
    }
  }

  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) {
    return new Date(
      Date.UTC(
        parsed.getUTCFullYear(),
        parsed.getUTCMonth(),
        parsed.getUTCDate(),
      ),
    ).toISOString();
  }

  return undefined;
}

function toIsoDate(
  year: number,
  month: number,
  day: number,
): string | undefined {
  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    year < 1900 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return undefined;
  }
  const iso = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(iso.getTime())) {
    return undefined;
  }
  return iso.toISOString();
}

function monthFromName(name: string): number | undefined {
  const lookup: Record<string, number> = {
    januari: 0,
    febuari: 1,
    februari: 1,
    maret: 2,
    april: 3,
    mei: 4,
    juni: 5,
    juli: 6,
    agustus: 7,
    september: 8,
    oktober: 9,
    nopember: 10,
    november: 10,
    desember: 11,
    december: 11,
  };
  const normalized = name.toLowerCase();
  return lookup[normalized];
}
