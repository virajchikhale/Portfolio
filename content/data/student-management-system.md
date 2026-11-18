# Student Management System: architecture

## Roles and portals
Five roles form a strict hierarchy: admin, principal, HOD (head of department), teacher and student. Staff sign in through their own login pages, and students sign in through a student login. What each role sees is decided on the server by permission functions, not by hiding menu items: an institution-wide scope for admin and principal, a department scope for HOD and teacher, and read-only access to their own records for students. Every page and every JSON endpoint checks the signed-in role before it does anything. Stack: PHP 8 with PostgreSQL 16 through PDO prepared statements, Bootstrap 4 and jQuery on the front end, packaged with Docker Compose.

## Sign-up, login and password reset
Principals, HODs and teachers register through a step-by-step wizard: the user enters an email, receives a 6-digit OTP, verifies it, and then the account is created. Students never self-register; an admin, principal or HOD enrols them and a temporary password is emailed. Password reset uses the same OTP flow. The OTP is generated randomly, only a keyed hash (HMAC-SHA256) of it is stored in the server session, it expires after 10 minutes, allows 5 wrong tries, enforces a 30 second resend delay and is single-use. It is verified on the server when the final form is submitted. Email is sent with PHPMailer; Mailpit catches every mail in Docker for local testing. In demo mode the OTP is also shown in a popup because demo visitors have no inbox. Passwords are stored with password_hash and checked with password_verify, and the login path equalises timing for unknown users.

## Session and request security
Session cookies are HttpOnly and SameSite=Lax, and the session id is regenerated on login. Every state-changing API call is a POST that must carry a CSRF token (sent as an X-CSRF-Token header and compared with hash_equals). All SQL uses prepared statements, and output is escaped.

## One-time setup order
The admin or principal creates departments, and staff register under them. A HOD or admin creates courses for a department and semester and assigns a teacher. A course has a code, name, semester (1 to 8), credits and one teacher. Students belong to a department and a semester, and a course's roster is simply every active student of that department and semester, so enrolling a student places them in all of their courses automatically.

## Taking attendance
For a course and a date the teacher marks each student Present, Late or Absent. The attendance table holds one row per course, student and date, enforced by a unique constraint, with status P, A or L and the user who marked it. Late counts as attended. Past days can be edited. A student's attendance percentage is attended sessions divided by total sessions, and anyone below the 75 percent threshold appears in the low-attendance report.

## Exams, marks and reports
A teacher creates exams for a course with a maximum mark and enters marks per student, with live percentage and grade, the class average and the pass count (pass mark 40 percent). Reports cover attendance, results and low attendance, can be exported as CSV or printed, and use the same queries as the on-screen views. Notices can be addressed to everyone, to staff only or to students only. Each role gets its own dashboard with stat cards, an attendance trend and "needs attention" lists, drawn with plain CSS and no chart library.

## Running it
Docker Compose starts the PHP app, PostgreSQL 16 and Mailpit, and a one-shot seed service loads demo data (a demo mode shows the demo logins on the login pages). Configuration comes from environment variables listed in .env.example.
