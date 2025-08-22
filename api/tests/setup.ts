/**
 * Global test setup and configuration
 */

// Additional global test configuration can be added here

// For tests that need their own cleanup, you can use this pattern:
/*
import { describe, it, beforeEach, afterEach } from "bun:test";

describe("Some test suite", () => {
  let createdEntities = [];

  beforeEach(async () => {
    // Setup test data
    const entity = await createSomeTestEntity();
    createdEntities.push({ type: "entityType", id: entity.id });
  });

  afterEach(async () => {
    // Clean up test data
    for (const entity of createdEntities) {
      await cleanupSpecificEntity(entity.type, entity.id);
    }
    createdEntities = [];
  });

  it("should do something", async () => {
    // Test logic
  });
});
*/
