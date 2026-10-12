import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  accountOperationDirectory,
  defaultConfigDirectory,
  defaultDataDirectory,
} from "../src/accounts/store.js";
import { defaultOperationDirectory } from "../src/operations/store.js";

test("keeps Organization configuration and operations under the org namespace", () => {
  const previousConfig = process.env.XDG_CONFIG_HOME;
  const previousData = process.env.XDG_DATA_HOME;
  process.env.XDG_CONFIG_HOME = "/tmp/pact-config-root";
  process.env.XDG_DATA_HOME = "/tmp/pact-data-root";
  try {
    assert.equal(defaultConfigDirectory(), resolve("/tmp/pact-config-root", "pact-privacy", "org"));
    assert.equal(defaultDataDirectory(), resolve("/tmp/pact-data-root", "pact-privacy", "org"));
    assert.equal(
      accountOperationDirectory("0x1111111111111111111111111111111111111111"),
      resolve("/tmp/pact-data-root", "pact-privacy", "org", "accounts", "0x1111111111111111111111111111111111111111", "operations"),
    );
    assert.equal(defaultOperationDirectory(), resolve("/tmp/pact-data-root", "pact-privacy", "org", "operations"));
  } finally {
    if (previousConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfig;
    if (previousData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = previousData;
  }
});
