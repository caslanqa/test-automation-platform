/** Petstore domain models — the subset of the OpenAPI v3 schema these examples exercise. */

/** A pet's lifecycle status in the store. */
export type PetStatus = 'available' | 'pending' | 'sold';

export interface Category {
  id?: number;
  name?: string;
}

export interface Tag {
  id?: number;
  name?: string;
}

export interface Pet {
  /** Server-assigned id; must stay within JS safe-integer range when set by a test. */
  id?: number;
  name: string;
  category?: Category;
  photoUrls: string[];
  tags?: Tag[];
  status?: PetStatus;
}
