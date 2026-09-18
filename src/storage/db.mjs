import { stateHome } from '../config.mjs'
import { initDb } from './sqlite.mjs'

const instances = new Map()

/**
 * Returns a singleton DB context { db, backend, stateHome } for the given environment.
 * Reuses initDb with WAL mode.
 * @param {object} [env=process.env]
 * @returns {{ db: import('better-sqlite3').Database | null, backend: 'sqlite' | 'json', stateHome: string }}
 */
export function getDb(env = process.env) {
  const home = stateHome(env)
  let instance = instances.get(home)
  if (!instance || (instance.backend === 'sqlite' && instance.db && !instance.db.open)) {
    instance = initDb(home)
    instances.set(home, instance)
  }
  return instance
}

/**
 * Closes the database handle and removes the singleton instance for the given environment.
 * @param {object} [env=process.env]
 */
export function closeDb(env = process.env) {
  const home = stateHome(env)
  const instance = instances.get(home)
  if (instance?.db && instance.db.open) {
    try {
      instance.db.close()
    } catch {
      // ignore
    }
  }
  instances.delete(home)
}

/**
 * Clears all cached singleton instances (for test teardown).
 */
export function resetDbInstances() {
  for (const [home, instance] of instances.entries()) {
    if (instance?.db && instance.db.open) {
      try {
        instance.db.close()
      } catch {
        // ignore
      }
    }
  }
  instances.clear()
}
