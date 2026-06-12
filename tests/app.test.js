const request = require('supertest');
const app = require('../src/app');

describe('DevOps Playground API', () => {
  describe('GET /', () => {
    it('returns status 200 and the welcome message', async () => {
      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('DevOps Playground API is running');
    });
  });

  describe('GET /health', () => {
    it('returns status 200 and service health details', async () => {
      const response = await request(app).get('/health');

      expect(response.status).toBe(200);
      expect(response.body.status).toBe('ok');
      expect(response.body.service).toBe('devops-playground');
      expect(response.body.uptime).toBeDefined();
      expect(response.body.timestamp).toBeDefined();
    });
  });

  describe('GET /version', () => {
    it('returns status 200 and project version details', async () => {
      const response = await request(app).get('/version');

      expect(response.status).toBe(200);
      expect(response.body.name).toBe('devops-playground');
      expect(response.body.version).toBe('1.0.0');
    });
  });
});
