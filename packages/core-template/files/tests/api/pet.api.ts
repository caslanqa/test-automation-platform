import { expect, test } from '@fixtures';

import type { Pet } from '@api/models/pet';

// Layer 3 — the test layer. Tests speak business language via the service (petService) and, where
// useful, drop to the base client (apiClient) to assert on the raw HTTP shape. Neither touches
// Playwright's request context directly. baseURL comes from the `api` project (API_BASE_URL).

test.describe('Petstore /pet API', () => {
  test('findAvailable returns only available pets', async ({ petService }) => {
    const pets = await petService.findAvailable();

    expect(pets.length).toBeGreaterThan(0);
    expect(pets.every(pet => pet.status === 'available')).toBeTruthy();
  });

  test('service-layer filter: available pets by category all carry that category', async ({
    petService,
  }) => {
    const category = 'Dogs';
    const all = await petService.findAvailable();
    const dogs = await petService.findAvailableByCategory(category);

    // The endpoint has no category filter — the service derived this by reading then filtering.
    expect(all.length).toBeGreaterThan(0);
    expect(dogs.length).toBeLessThanOrEqual(all.length);
    expect(dogs.every(pet => pet.category?.name === category)).toBeTruthy();
  });

  test('CRUD: create → read back → delete', async ({ petService }) => {
    const petId = Date.now(); // unique per run, within JS safe-integer range
    const draft: Pet = {
      id: petId,
      name: 'claude-e2e',
      photoUrls: ['https://example.com/dog.png'],
      category: { id: 1, name: 'Dogs' },
      tags: [{ id: 1, name: 'e2e' }],
      status: 'available',
    };

    const created = await petService.create(draft);
    expect(created.id).toBe(petId);
    expect(created.name).toBe(draft.name);

    const fetched = await petService.getById(petId);
    expect(fetched.name).toBe(draft.name);
    expect(fetched.status).toBe('available');

    const deleteStatus = await petService.deleteById(petId);
    expect(deleteStatus).toBe(200);
  });

  test('base client: raw findByStatus response shape', async ({ apiClient }) => {
    const res = await apiClient.get<Pet[]>('/pet/findByStatus', { params: { status: 'pending' } });

    expect(res.ok).toBeTruthy();
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBeTruthy();
  });
});
