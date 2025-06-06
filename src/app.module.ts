import { Module } from '@nestjs/common';
import { McpModule } from './mcp/mcp.module';
import { McpModule as McpDecModule } from '@rekog/mcp-nest';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import typeorm from './config/typeorm';

@Module({
  imports: [
    McpModule,
    // ConfigModule.forRoot({
    //   isGlobal: true,
    //   load: [typeorm],
    // }),
    //
    // TypeOrmModule.forRootAsync({
    //   inject: [ConfigService],
    //   useFactory: (configService: ConfigService) =>
    //     configService.get('typeorm'),
    // }),
    // McpDecModule.forRoot({
    //   name: 'my-mcp-server',
    //   version: '1.0.0',
    // }),
  ],
  providers: [],
})
export class AppModule {}
