import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import {
  fetchCategories,
  createFeed,
  fetchSubscriptions,
  importCategories,
  exportCategories,
} from '../client';

vi.mock('axios', () => {
  const mockAxiosInstance = {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return {
    default: {
      create: vi.fn(() => mockAxiosInstance),
      ...mockAxiosInstance,
    },
  };
});

// Get the mocked instance that api = axios.create(...) returns
const mockedInstance = (axios.create as ReturnType<typeof vi.fn>).mock.results[0]?.value ?? axios;

// Force re-import to use the mocked axios
let apiModule: typeof import('../client');

beforeEach(async () => {
  vi.clearAllMocks();
  // Re-import to ensure mocked module is used
  vi.resetModules();
  const mod = await import('../client');
  apiModule = mod;
});

describe('API Client', () => {
  it('fetchCategories calls correct URL', async () => {
    const mockData = { categories: [], total_count: 0, uncategorized_count: 0 };
    mockedInstance.get.mockResolvedValueOnce({ data: mockData });
    await apiModule.fetchCategories();
    expect(mockedInstance.get).toHaveBeenCalledWith('/categories/');
  });

  it('createFeed sends correct payload', async () => {
    const feedData = { name: 'My Feed', filter_video_type: 'video' };
    mockedInstance.post.mockResolvedValueOnce({ data: { id: 1, ...feedData } });
    await apiModule.createFeed(feedData);
    expect(mockedInstance.post).toHaveBeenCalledWith('/feeds/', feedData);
  });

  it('pagination params passed correctly', async () => {
    const mockResponse = { data: { items: [], total: 0, page: 2, per_page: 20, has_more: false } };
    mockedInstance.get.mockResolvedValueOnce(mockResponse);
    await apiModule.fetchSubscriptions({ page: 2, per_page: 20, category_id: 5 });
    expect(mockedInstance.get).toHaveBeenCalledWith('/subscriptions/', {
      params: { page: 2, per_page: 20, category_id: 5 },
    });
  });

  it('importCategories sends FormData', async () => {
    mockedInstance.post.mockResolvedValueOnce({ data: {} });
    const file = new File(['{}'], 'categories.json', { type: 'application/json' });
    await apiModule.importCategories(file);
    const [url, body, config] = mockedInstance.post.mock.calls[0];
    expect(url).toBe('/categories/import/');
    expect(body).toBeInstanceOf(FormData);
    expect(config.headers['Content-Type']).toBe('multipart/form-data');
  });

  it('exportCategories uses blob responseType', async () => {
    mockedInstance.get.mockResolvedValueOnce({ data: new Blob() });
    await apiModule.exportCategories();
    expect(mockedInstance.get).toHaveBeenCalledWith('/categories/export/', { responseType: 'blob' });
  });
});
