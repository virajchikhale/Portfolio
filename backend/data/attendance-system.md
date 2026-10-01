# Attendance Management System: architecture

## Roles and portals
Three roles use the app: principal, HOD (head of department) and teacher. Each signs in to its own portal. The principal and HOD set the college up once, and teachers then mark every lecture. Every portal page checks the session before it renders. Stack: PHP 8 with PostgreSQL.

## Sign-up, login and password reset
Sign-up uses a wizard: the user enters an email, receives a 6-digit OTP, verifies it, and then the account is created. Password reset follows the same OTP flow and ends by saving the new password. The OTP is kept in the server session, expires after 10 minutes and allows 5 wrong tries. Email is sent with PHPMailer (Mailpit is used in Docker for local testing). Only a correct password starts a session.

## One-time setup order
The principal adds a department. The HOD signs up and claims it, then adds subjects (per year, theory or practical) and creates classes (one per year, 1 to 3), and assigns teachers who have already signed up in the same department to subjects and as class teacher. The class teacher adds students. Only then can attendance be taken. A department holds one HOD, a year holds one class, and a class or subject takes one teacher.

## Taking attendance
For every lecture the teacher picks subject, date and time, which opens (or reuses) one row in the attendance table, then marks each student Present or Absent; each tap is its own request. The attendance table has one row per lecture and one column per student, named S_<enrollment>, with values 1 (present), 0 (absent) and -1 (not marked, excluded from percentages).

## Reports
Reports are read back by date range, with percentage per subject, and can be exported as CSV. A class teacher's report covers every subject of the year; other teachers see only their own subjects.
