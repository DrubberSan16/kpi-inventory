import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { TimezoneInterceptor } from './common/interceptors/timezone.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const port = Number(config.get('PORT') || 3000);
  const basePath = String(config.get('BASE_PATH') || '').trim(); // /kpi_security
  const globalPrefix = basePath.replace(/^\//, '').replace(/\/$/, ''); // kpi_security

  if (globalPrefix) app.setGlobalPrefix(globalPrefix);

  const swaggerConfig = new DocumentBuilder()
    .setTitle(globalPrefix || 'API')
    .setDescription('API Documentation')
    .setVersion('1.0.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        in: 'header',
      },
      'inventory', // ✅ nombre del security scheme
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);

  // ✅ Swagger SIEMPRE en /<prefix>/docs
  const swaggerPath = globalPrefix ? `${globalPrefix}/docs` : 'docs';
  SwaggerModule.setup(swaggerPath, app, document);
  app.getHttpAdapter().get(
    globalPrefix ? `/${globalPrefix}/docs-json` : '/docs-json',
    (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(document);
    },
  );
  app.useGlobalInterceptors(new TimezoneInterceptor());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(port, '127.0.0.1');
}
bootstrap();
