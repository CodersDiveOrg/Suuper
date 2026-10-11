import { Module } from "@nestjs/common";
import {
  BusinessInvitationsController,
  InvitationsController,
} from "./invitations.controller";
import { InvitationsService } from "./invitations.service";

@Module({
  controllers: [BusinessInvitationsController, InvitationsController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
