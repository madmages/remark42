import { BASE_URL, API_BASE, HEADER_X_JWT } from './constants';
import { siteId } from './settings';
import { StaticStore } from './static_store';
import { getCookie } from './cookies';
import { httpErrorMap, isFailedFetch, httpMessages } from '@app/utils/errorUtils';

export type FetcherMethod = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head';
const methods: FetcherMethod[] = ['get', 'post', 'put', 'patch', 'delete', 'head'];

interface FetcherInitBase {
  url: string;
  overriddenApiBase?: string;
  withCredentials?: boolean;
  /** whether log error message to console */
  logError?: boolean;
}

interface FetcherInitJSON extends FetcherInitBase {
  contentType?: 'application/json';
  body?: string | object | Blob | ArrayBuffer;
}

interface FetcherInitMultipart extends FetcherInitBase {
  contentType: 'multipart/form-data';
  body: FormData;
}

type FetcherInit = string | FetcherInitJSON | FetcherInitMultipart;

type FetcherObject = { [K in FetcherMethod]: <T = unknown>(data: FetcherInit) => Promise<T> };

/** JWT token received from server and will be send by each request, if it present */
let activeJwtToken: string | undefined;

const fetcher = methods.reduce<Partial<FetcherObject>>((acc, method) => {
  acc[method] = <T = unknown>(data: FetcherInit): Promise<T> => {
    const {
      url,
      body = undefined,
      withCredentials = false,
      overriddenApiBase = API_BASE,
      contentType = 'application/json',
      logError = true,
    } = typeof data === 'string' ? { url: data } : data;
    const basename = `${BASE_URL}${overriddenApiBase}`;

    const headers = new Headers({
      Accept: 'application/json',
      'X-XSRF-TOKEN': getCookie('XSRF-TOKEN') || '',
    });

    if (contentType !== 'multipart/form-data') {
      headers.append('Content-Type', contentType);
    }

    if (activeJwtToken) {
      headers.append(HEADER_X_JWT, activeJwtToken);
    }

    let rurl = `${basename}${url}`;

    const parameters: RequestInit = {
      method,
      headers,
      mode: 'cors',
      credentials: withCredentials ? 'include' : 'omit',
    };

    if (body) {
      if (contentType === 'multipart/form-data') {
        parameters.body = body as FormData;
      } else if (typeof body === 'object' && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
        parameters.body = JSON.stringify(body);
      } else {
        parameters.body = body;
      }
    }

    if (siteId && method !== 'post' && !rurl.includes('?site=') && !rurl.includes('&site=')) {
      rurl += (rurl.includes('?') ? '&' : '?') + `site=${siteId}`;
    }

    return fetch(rurl, parameters)
      .then(res => {
        const date = (res.headers.has('date') && res.headers.get('date')) || '';
        const timestamp = isNaN(Date.parse(date)) ? 0 : Date.parse(date);
        const timeDiff = (new Date().getTime() - timestamp) / 1000;
        StaticStore.serverClientTimeDiff = timeDiff;

        // backend could update jwt in any time. so, we should handle it
        if (res.headers.has(HEADER_X_JWT)) {
          activeJwtToken = res.headers.get(HEADER_X_JWT) as string;
        }

        if (res.status === 403 && activeJwtToken) {
          activeJwtToken = undefined;
        }

        if (res.status >= 400) {
          if (httpErrorMap.has(res.status)) {
            const descriptor = httpErrorMap.get(res.status) || httpMessages.unexpectedError;
            throw {
              code: res.status,
              error: descriptor.defaultMessage,
            };
          }
          return res.text().then(text => {
            let err;
            try {
              err = JSON.parse(text);
            } catch (e) {
              if (logError) {
                // eslint-disable-next-line no-console
                console.error(err);
              }
              throw {
                code: 0,
                error: httpMessages.unexpectedError.defaultMessage,
              };
            }
            throw err;
          });
        }

        if (res.headers.has('Content-Type') && res.headers.get('Content-Type')!.indexOf('application/json') === 0) {
          return res.json();
        }

        return res.text();
      })
      .catch(e => {
        if (isFailedFetch(e)) {
          throw {
            code: -2,
            error: e.message,
          };
        }
        throw e;
      });
  };
  return acc;
}, {}) as FetcherObject;

export default fetcher;
