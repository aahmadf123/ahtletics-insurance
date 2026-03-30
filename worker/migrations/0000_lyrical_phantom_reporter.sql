CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text,
	`action` text NOT NULL,
	`performed_by` text NOT NULL,
	`details` text,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`request_id`) REFERENCES `insurance_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `insurance_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`student_name` text NOT NULL,
	`rocket_number` text NOT NULL,
	`sport` text NOT NULL,
	`term` text NOT NULL,
	`premium_cost` real NOT NULL,
	`status` text DEFAULT 'PENDING_SPORT_ADMIN' NOT NULL,
	`workflow_instance_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE TABLE `signatures` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`signatory_role` text NOT NULL,
	`signatory_email` text NOT NULL,
	`signatory_name` text NOT NULL,
	`ip_address` text NOT NULL,
	`timestamp` text DEFAULT CURRENT_TIMESTAMP,
	FOREIGN KEY (`request_id`) REFERENCES `insurance_requests`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sport_administrators` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`title` text NOT NULL,
	`email` text NOT NULL,
	`is_cfo` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sports_programs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`gender` text NOT NULL,
	`head_coach` text,
	`sport_admin_id` text,
	FOREIGN KEY (`sport_admin_id`) REFERENCES `sport_administrators`(`id`) ON UPDATE no action ON DELETE no action
);
