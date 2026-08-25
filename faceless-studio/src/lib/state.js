import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, ensureDir } from "./paths.js";

/**
 * Persistent per-channel memory. Two roles:
 *  - dedupe: never ship the same angle or hook twice
 *  - variation: force structural rotation between consecutive uploads, which is
 *    what keeps the channel out of YouTube's "inauthentic / mass-produced" bucket
 */
export class Store {
  constructor(channelSlug) {
    ensureDir(STATE_DIR);
    this.file = path.join(STATE_DIR, `${channelSlug}.json`);
    this.data = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : { ideas: [], videos: [] };
    this.data.ideas ??= [];
    this.data.videos ??= [];
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /* ---------- ideas ---------- */

  addIdeas(ideas) {
    const seen = new Set(this.data.ideas.map((i) => i.slug));
    const fresh = ideas.filter((i) => !seen.has(i.slug));
    this.data.ideas.push(...fresh);
    this.save();
    return fresh;
  }

  pendingIdeas() {
    return this.data.ideas.filter((i) => i.status === "pending");
  }

  findIdea(idOrSlug) {
    return this.data.ideas.find((i) => i.id === idOrSlug || i.slug === idOrSlug);
  }

  markIdea(id, status, extra = {}) {
    const idea = this.data.ideas.find((i) => i.id === id);
    if (idea) Object.assign(idea, { status, ...extra });
    this.save();
  }

  /* ---------- videos ---------- */

  addVideo(record) {
    this.data.videos.push(record);
    this.save();
  }

  recentVideos(n) {
    return this.data.videos.slice(-n);
  }

  /* ---------- variation / dedupe views ---------- */

  recentFormatIds(n) {
    return this.recentVideos(n).map((v) => v.formatId);
  }

  recentHooks(n) {
    return this.recentVideos(n).map((v) => v.hook).filter(Boolean);
  }

  /** Everything already used or queued, so ideation never repeats an angle. */
  knownTopics(n) {
    const fromVideos = this.data.videos.map((v) => v.title).filter(Boolean);
    const fromIdeas = this.data.ideas.map((i) => i.title).filter(Boolean);
    return [...fromIdeas, ...fromVideos].slice(-n);
  }
}
