import type { ApiClient } from '../core/ApiClient';
import type { Pet, PetStatus } from '../models/pet';

/**
 * Layer 2 — the business/service layer for Petstore's /pet resource. It calls the base
 * {@link ApiClient} (layer 1) and turns raw HTTP into business operations: fetch by status, CRUD,
 * and — the point of this layer — results the API does not offer directly, e.g. "available pets in
 * a given category", by reading a list and filtering on a property HERE rather than in the test.
 *
 * @example
 * const pets = await petService.findAvailableByCategory('Dogs');
 */
export class PetService {
  private readonly client: ApiClient;

  constructor(client: ApiClient) {
    this.client = client;
  }

  /** GET /pet/findByStatus — every pet with the given status. */
  async findByStatus(status: PetStatus): Promise<Pet[]> {
    const res = await this.client.get<Pet[]>('/pet/findByStatus', { params: { status } });
    if (!res.ok) {
      throw new Error(`[PetService] findByStatus(${status}) failed: HTTP ${res.status}`);
    }
    return res.data ?? [];
  }

  /** Convenience wrapper: all currently available pets. */
  async findAvailable(): Promise<Pet[]> {
    return this.findByStatus('available');
  }

  /**
   * Business rule (read-then-filter): fetch available pets, then keep only those carrying the given
   * category name. The endpoint has no category filter, so the logic lives in this layer — the test
   * just asks for "available Dogs" and asserts on the result.
   */
  async findAvailableByCategory(categoryName: string): Promise<Pet[]> {
    const available = await this.findAvailable();
    return available.filter(pet => pet.category?.name === categoryName);
  }

  /** GET /pet/{id} — a single pet. */
  async getById(id: number): Promise<Pet> {
    const res = await this.client.get<Pet>(`/pet/${id}`);
    if (!res.ok) {
      throw new Error(`[PetService] getById(${id}) failed: HTTP ${res.status}`);
    }
    return res.data;
  }

  /** POST /pet — create a pet, returning the created record. */
  async create(pet: Pet): Promise<Pet> {
    const res = await this.client.post<Pet>('/pet', { data: pet });
    if (!res.ok) {
      throw new Error(`[PetService] create('${pet.name}') failed: HTTP ${res.status}`);
    }
    return res.data;
  }

  /** DELETE /pet/{id} — remove a pet; returns the HTTP status so tests can assert on it. */
  async deleteById(id: number): Promise<number> {
    const res = await this.client.delete(`/pet/${id}`);
    return res.status;
  }
}
