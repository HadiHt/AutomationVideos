import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const INITIAL_STATE = {
  account: null,
  authStates: [],
  jobs: [],
  publishes: []
};

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  async ensure() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      await fs.access(this.filePath);
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
      await fs.writeFile(this.filePath, JSON.stringify(INITIAL_STATE, null, 2));
    }
  }

  async read() {
    await this.ensure();
    const content = await fs.readFile(this.filePath, "utf8");
    return JSON.parse(content);
  }

  async write(state) {
    await this.ensure();
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2));
  }

  async update(updater) {
    const state = await this.read();
    const next = await updater(structuredClone(state));
    await this.write(next);
    return next;
  }

  async saveAuthState(state) {
    return this.update((current) => {
      current.authStates = current.authStates.filter((item) => item.expiresAt > Date.now());
      current.authStates.push(state);
      return current;
    });
  }

  async consumeAuthState(value) {
    let match = null;
    await this.update((current) => {
      current.authStates = current.authStates.filter((item) => {
        if (item.value === value) {
          match = item;
          return false;
        }
        return item.expiresAt > Date.now();
      });
      return current;
    });
    return match;
  }

  async saveAccount(account) {
    await this.update((current) => {
      current.account = account;
      return current;
    });
    return account;
  }

  async addJob(job) {
    await this.update((current) => {
      current.jobs.unshift(job);
      return current;
    });
    return job;
  }

  async updateJob(jobId, patch) {
    let nextJob = null;
    await this.update((current) => {
      current.jobs = current.jobs.map((job) => {
        if (job.id !== jobId) {
          return job;
        }
        nextJob = { ...job, ...patch, updatedAt: new Date().toISOString() };
        return nextJob;
      });
      return current;
    });
    return nextJob;
  }

  async getJob(jobId) {
    const state = await this.read();
    return state.jobs.find((job) => job.id === jobId) || null;
  }

  async getState() {
    return this.read();
  }

  async savePublish(record) {
    await this.update((current) => {
      const existingIndex = current.publishes.findIndex((item) => item.publishId === record.publishId);
      if (existingIndex >= 0) {
        current.publishes[existingIndex] = record;
      } else {
        current.publishes.unshift(record);
      }
      return current;
    });
    return record;
  }

  async getPublish(publishId) {
    const state = await this.read();
    return state.publishes.find((item) => item.publishId === publishId) || null;
  }
}

export function createId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}
