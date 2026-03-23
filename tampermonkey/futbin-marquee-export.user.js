// ==UserScript==
// @name         Futbin Challenges Export
// @namespace    https://futbin.com/
// @version      0.2.0
// @description  Export Futbin SBC groups and challenge requirements from listing pages.
// @match        https://www.futbin.com/squad-building-challenges*
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const GROUP_LINK_SELECTOR =
    '.sbc-cards-parent .sbc-card-wrapper > a[href*="/squad-building-challenge/"]';
  const GROUP_CONTAINER_SELECTOR = ".sbc-cards-parent";
  const PAGINATION_LINK_SELECTOR =
    '.pagination-buttons-wrapper a.pagination-button[href*="page="]';
  const DETAIL_CARD_SELECTOR = ".challenges-wrapper > .sbc-box-wrapper";
  const START_LINK_SELECTOR =
    '.sbc-box-bottom a[href*="/squad-building-challenge/ea/"]';
  const CARD_NAME_SELECTOR = ".og-card-wrapper-top .xxs-font.bold";
  const REQUIREMENT_ROW_SELECTOR =
    ".sbc-box-back .sbc-requirements > .challenge-box-description-row";
  const REACT_DATA_SELECTOR =
    '#sbc-squad-builder-react-wrapper script[data-react-data]';

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const text = (value) =>
    value == null ? "" : String(value).replace(/\s+/g, " ").trim();

  const absoluteUrl = (href) => new URL(href, window.location.origin).toString();

  const parseChallengeIdFromUrl = (href) => {
    const match = String(href || "").match(/\/squad-building-challenge\/ea\/(\d+)\//i);
    return match ? Number(match[1]) : null;
  };

  const parseGroupIdFromUrl = (href) => {
    const match = String(href || "").match(/\/(\d+)\/squad-building-challenge\/(\d+)/i);
    return match ? Number(match[2]) : null;
  };

  const parsePageNumberFromUrl = (href) => {
    try {
      const url = new URL(String(href || ""), window.location.origin);
      const page = Number(url.searchParams.get("page") || "1");
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch {
      return 1;
    }
  };

  const makeButton = () => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Export Challenges Raw";
    button.id = "futbin-challenges-export-btn";
    Object.assign(button.style, {
      position: "fixed",
      right: "20px",
      bottom: "20px",
      zIndex: "999999",
      padding: "10px 14px",
      borderRadius: "10px",
      border: "1px solid #22c55e",
      background: "#0f172a",
      color: "#ecfeff",
      fontSize: "14px",
      fontWeight: "600",
      cursor: "pointer",
      boxShadow: "0 8px 20px rgba(0,0,0,0.35)",
    });
    return button;
  };

  const setButtonState = (button, label, disabled) => {
    button.textContent = label;
    button.disabled = Boolean(disabled);
    button.style.opacity = disabled ? "0.7" : "1";
    button.style.cursor = disabled ? "progress" : "pointer";
  };

  const collectGroupLinks = (doc, sourcePageUrl) => {
    return [...doc.querySelectorAll(GROUP_LINK_SELECTOR)]
      .map((anchor) => {
        const href = anchor.getAttribute("href");
        const groupUrl = href ? absoluteUrl(href) : null;
        if (!groupUrl) return null;
        return {
          futbinGroupId: parseGroupIdFromUrl(groupUrl),
          groupUrl,
          groupName: text(
            anchor.querySelector(".og-card-wrapper-top .text-ellipsis")?.textContent,
          ),
          groupDescription: text(
            anchor.querySelector("p.no-margin")?.textContent,
          ),
          sourcePageUrl,
        };
      })
      .filter(Boolean)
      .reduce((acc, item) => {
        if (!acc.some((entry) => entry.groupUrl === item.groupUrl)) acc.push(item);
        return acc;
      }, []);
  };

  const parseTotalListingPages = (doc, currentUrl) => {
    const pageNumbers = [...doc.querySelectorAll(PAGINATION_LINK_SELECTOR)]
      .map((link) => parsePageNumberFromUrl(link.getAttribute("href")))
      .filter((value) => Number.isFinite(value) && value > 0);
    pageNumbers.push(parsePageNumberFromUrl(currentUrl));
    return pageNumbers.length ? Math.max(...pageNumbers) : 1;
  };

  const buildListingPageUrl = (currentUrl, pageNumber) => {
    const url = new URL(currentUrl, window.location.origin);
    if (pageNumber <= 1) url.searchParams.delete("page");
    else url.searchParams.set("page", String(pageNumber));
    return url.toString();
  };

  const collectListingDocuments = async (currentUrl, button) => {
    const currentPage = parsePageNumberFromUrl(currentUrl);
    const totalPages = parseTotalListingPages(document, currentUrl);
    const pages = [];

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber += 1) {
      const pageUrl = buildListingPageUrl(currentUrl, pageNumber);
      if (pageNumber === currentPage) {
        pages.push({ pageNumber, pageUrl, doc: document });
        continue;
      }

      setButtonState(button, `Fetching list ${pageNumber}/${totalPages}...`, true);
      const doc = await fetchDocument(pageUrl);
      pages.push({ pageNumber, pageUrl, doc });
      await sleep(200);
    }

    return { totalPages, pages };
  };

  const fetchDocument = async (url) => {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      throw new Error(`Fetch failed ${response.status} for ${url}`);
    }
    const html = await response.text();
    return new DOMParser().parseFromString(html, "text/html");
  };

  const extractRequirementRow = (row) => {
    const textContent = text(row.textContent);
    const images = [...row.querySelectorAll("img")].map((img) => ({
      alt: text(img.getAttribute("alt")),
      title: text(img.getAttribute("title")),
      src: img.getAttribute("src") || null,
    }));
    return {
      text: textContent,
      images,
    };
  };

  const parseReactDataJson = (doc) => {
    const scripts = [...doc.querySelectorAll(REACT_DATA_SELECTOR)];
    for (const script of scripts) {
      const raw = text(script.textContent);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(script.textContent);
        if (parsed && typeof parsed === "object") return parsed;
      } catch {
        // ignore malformed/non-matching blobs
      }
    }
    return null;
  };

  const extractFormationData = (doc) => {
    const reactData = parseReactDataJson(doc);
    const formation = reactData?.requirementData?.formation || null;
    const positions = Array.isArray(formation?.positions) ? formation.positions : [];
    const squadSlots = [];

    for (let index = 0; index + 1 < positions.length; index += 2) {
      const slotId = text(positions[index]?.value);
      const positionName = text(positions[index + 1]?.value);
      if (!slotId || !positionName) continue;
      squadSlots.push({
        slotId,
        slotIndex: squadSlots.length,
        positionName,
      });
    }

    return {
      formationName: text(formation?.displayName) || null,
      formationCode: text(formation?.formation?.value) || null,
      formationSource: squadSlots.length ? "challenge-react-data" : null,
      squadSlots,
    };
  };

  const extractGroupFromDocument = (doc, fallback = {}) => {
    const formationData = extractFormationData(doc);
    const canonical = doc.querySelector('link[rel="canonical"]')?.href || fallback.groupUrl || null;
    const challenges = [...doc.querySelectorAll(DETAIL_CARD_SELECTOR)].map((card) => {
      const startHref = card.querySelector(START_LINK_SELECTOR)?.getAttribute("href") || null;
      const challengeUrl = startHref ? absoluteUrl(startHref) : null;
      const requirementRows = [...card.querySelectorAll(REQUIREMENT_ROW_SELECTOR)].map(
        extractRequirementRow,
      );
      return {
        eaChallengeId: parseChallengeIdFromUrl(challengeUrl),
        challengeName: text(card.querySelector(CARD_NAME_SELECTOR)?.textContent),
        challengeUrl,
        formationName: formationData.formationName,
        formationCode: formationData.formationCode,
        formationSource: formationData.formationSource,
        squadSlots: formationData.squadSlots,
        requirementsText: requirementRows.map((entry) => entry.text).filter(Boolean),
        requirementsDetailed: requirementRows,
      };
    });

    return {
      futbinGroupId: fallback.futbinGroupId ?? parseGroupIdFromUrl(canonical),
      year: (() => {
        const match = String(canonical || "").match(/\/(\d+)\/squad-building-challenge\//i);
        return match ? Number(match[1]) : null;
      })(),
      groupName:
        text(doc.querySelector("h1.page-header-top")?.textContent) ||
        fallback.groupName ||
        null,
      groupDescription:
        text(doc.querySelector("h2.page-header-top-extra")?.textContent) ||
        fallback.groupDescription ||
        null,
      groupUrl: canonical,
      challenges,
    };
  };

  const downloadJson = (data, filename) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const runExport = async (button) => {
    setButtonState(button, "Scanning listing pages...", true);

    const { totalPages, pages } = await collectListingDocuments(window.location.href, button);
    const groupLinks = pages
      .flatMap((page) => collectGroupLinks(page.doc, page.pageUrl))
      .reduce((acc, item) => {
        if (!acc.some((entry) => entry.groupUrl === item.groupUrl)) acc.push(item);
        return acc;
      }, []);

    if (!groupLinks.length) {
      throw new Error("No Futbin challenge group links found on the current page.");
    }

    const groups = [];
    for (let index = 0; index < groupLinks.length; index += 1) {
      const group = groupLinks[index];
      setButtonState(button, `Fetching ${index + 1}/${groupLinks.length}...`, true);
      const doc = await fetchDocument(group.groupUrl);
      groups.push(extractGroupFromDocument(doc, group));
      await sleep(300);
    }

    const payload = {
      source: "futbin",
      harvestVersion: "0.2.0",
      harvestedAt: new Date().toISOString(),
      queryUrl: window.location.href,
      totalListingPages: totalPages,
      listingPageUrls: pages.map((page) => page.pageUrl),
      totalGroups: groups.length,
      totalChallenges: groups.reduce(
        (sum, group) => sum + (Array.isArray(group.challenges) ? group.challenges.length : 0),
        0,
      ),
      groups,
    };

    downloadJson(
      payload,
      `futbin-challenges-raw-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
    );
    setButtonState(button, `Exported ${payload.totalChallenges} challenges`, false);
  };

  const init = () => {
    if (!window.location.pathname.startsWith("/squad-building-challenges")) return;
    if (!document.querySelector(GROUP_CONTAINER_SELECTOR)) return;
    if (document.getElementById("futbin-challenges-export-btn")) return;

    const button = makeButton();
    button.addEventListener("click", async () => {
      try {
        await runExport(button);
      } catch (error) {
        console.error("[Futbin Challenges Export] Failed", error);
        setButtonState(button, "Export failed - retry", false);
        alert(`Futbin export failed: ${error?.message || error}`);
      }
    });
    document.body.appendChild(button);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
