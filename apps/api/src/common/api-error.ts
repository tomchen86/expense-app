import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';

export interface ApiErrorDetails {
  code: string;
  message: string;
  field?: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorDetails;
}

export const createApiError = (
  code: string,
  message: string,
  extras: Partial<Omit<ApiErrorDetails, 'code' | 'message'>> = {},
): ApiErrorResponse => ({
  success: false,
  error: {
    code,
    message,
    ...extras,
  },
});

export class ApiHttpException extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    extras: Partial<Omit<ApiErrorDetails, 'code' | 'message'>> = {},
  ) {
    super(createApiError(code, message, extras), status);
  }
}

export class ApiBadRequestException extends BadRequestException {
  constructor(
    code: string,
    message: string,
    extras: Partial<Omit<ApiErrorDetails, 'code' | 'message'>> = {},
  ) {
    super(createApiError(code, message, extras));
  }
}

export class ApiUnauthorizedException extends UnauthorizedException {
  constructor(
    code: string,
    message: string,
    extras: Partial<Omit<ApiErrorDetails, 'code' | 'message'>> = {},
  ) {
    super(createApiError(code, message, extras));
  }
}

export class ApiConflictException extends ConflictException {
  constructor(
    code: string,
    message: string,
    extras: Partial<Omit<ApiErrorDetails, 'code' | 'message'>> = {},
  ) {
    super(createApiError(code, message, extras));
  }
}

export class ApiNotFoundException extends NotFoundException {
  constructor(
    code: string,
    message: string,
    extras: Partial<Omit<ApiErrorDetails, 'code' | 'message'>> = {},
  ) {
    super(createApiError(code, message, extras));
  }
}
