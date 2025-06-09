import { NestFactory } from '@nestjs/core';
import { AppModule } from '@/app.module';

// async function bootstrap() {
//   const app = await NestFactory.createApplicationContext(AppModule, {
//     logger: ['log'],
//   });
//   return app.close();
// }
// void bootstrap();

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'], // 只显示错误和警告
  });
  await app.listen(3030);
}

void bootstrap();
