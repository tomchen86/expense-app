interface ResponseMeta {
  pagination?: PaginationMeta;
  filters?: Record<string, unknown>;
}

export class ApiResponse<T> {
  success: boolean = true;
  data: T;
  meta?: ResponseMeta;

  constructor(data: T, meta?: ResponseMeta) {
    this.data = data;
    this.meta = meta;
  }
}

export class ApiError {
  success: boolean = false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };

  constructor(code: string, message: string, details?: unknown) {
    this.error = { code, message, details };
  }
}

export class PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;

  constructor(page: number, limit: number, total: number) {
    this.page = page;
    this.limit = limit;
    this.total = total;
    this.totalPages = Math.ceil(total / limit);
    this.hasNextPage = page < this.totalPages;
    this.hasPreviousPage = page > 1;
  }
}
