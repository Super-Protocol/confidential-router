import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChatMessage } from '../db/entities/chat-message.entity.js';
import { ChatThread } from '../db/entities/chat-thread.entity.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ChatThread, ChatMessage])],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
