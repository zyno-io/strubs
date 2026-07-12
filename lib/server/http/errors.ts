export class HttpNotFoundError extends Error {}
export class HttpBadRequestError extends Error {}
export class HttpUnauthorizedError extends Error {}

export const httpErrorTypes = {
    notFound: HttpNotFoundError,
    badRequest: HttpBadRequestError,
    unauthorized: HttpUnauthorizedError
};
